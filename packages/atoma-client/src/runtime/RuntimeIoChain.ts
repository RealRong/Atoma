import type { ObservabilityContext } from 'atoma-observability'
import { Protocol, type Operation, type OperationResult, type Query, type QueryResultData, type WriteAction, type WriteItem, type WriteOptions, type WriteResultData } from 'atoma-protocol'
import type { Entity, RuntimeIo, RuntimeTransform, StoreHandle } from 'atoma-core'
import type { HandlerChain } from '../plugins/HandlerChain'
import type { IoContext, ReadContext, ReadRequest, QueryResult } from '../plugins/types'

function requireSingleResult(results: OperationResult[], missingMessage: string): OperationResult {
    const result = results[0]
    if (!result) throw new Error(missingMessage)
    return result
}

function toOpsError(result: OperationResult, tag: string): Error {
    if ((result as any).ok) return new Error(`[${tag}] Operation failed`)
    const message = ((result as any).error && typeof ((result as any).error as any).message === 'string')
        ? ((result as any).error as any).message
        : `[${tag}] Operation failed`
    const err = new Error(message)
    ;(err as any).error = (result as any).error
    return err
}

function toProtocolValidationError(error: unknown, fallbackMessage: string): Error {
    const standard = Protocol.error.wrap(error, {
        code: 'INVALID_RESPONSE',
        message: fallbackMessage,
        kind: 'validation'
    })
    const err = new Error(`[Atoma] ${standard.message}`)
    ;(err as any).error = standard
    return err
}

export class RuntimeIoChain implements RuntimeIo {
    private readonly ioChain: HandlerChain
    private readonly readChain: HandlerChain
    private readonly transform: RuntimeTransform
    private readonly now: () => number
    private readonly clientId: string

    constructor(args: {
        io: HandlerChain
        read: HandlerChain
        transform: RuntimeTransform
        now?: () => number
        clientId: string
    }) {
        this.ioChain = args.io
        this.readChain = args.read
        this.transform = args.transform
        this.now = args.now ?? (() => Date.now())
        this.clientId = args.clientId
    }

    executeOps: RuntimeIo['executeOps'] = async (input) => {
        const context = input.context
        const traceId = (typeof context?.traceId === 'string' && context.traceId) ? context.traceId : undefined
        const opsWithTrace = Protocol.ops.build.withTraceMeta({
            ops: input.ops,
            traceId,
            ...(context ? { nextRequestId: context.requestId } : {})
        })
        const meta = Protocol.ops.build.buildRequestMeta({
            now: this.now,
            traceId,
            requestId: context ? context.requestId() : undefined
        })
        Protocol.ops.validate.assertOutgoingOps({ ops: opsWithTrace, meta })

        const res = await this.ioChain.execute({
            ops: opsWithTrace,
            meta,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(context ? { context } : {})
        }, { clientId: this.clientId } as IoContext)

        try {
            return Protocol.ops.validate.assertOperationResults((res as any).results)
        } catch (error) {
            throw toProtocolValidationError(error, 'Invalid ops response')
        }
    }

    query: RuntimeIo['query'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        query: Query,
        context?: ObservabilityContext,
        signal?: AbortSignal
    ): Promise<QueryResult> => {
        const req: ReadRequest = {
            storeName: handle.storeName,
            query,
            ...(context ? { context } : {}),
            ...(signal ? { signal } : {})
        }
        const ctx: ReadContext = {
            clientId: this.clientId,
            store: String(handle.storeName)
        }
        return await this.readChain.execute(req, ctx)
    }

    write: RuntimeIo['write'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        input: { action: WriteAction; items: WriteItem[]; options?: WriteOptions },
        context?: ObservabilityContext,
        signal?: AbortSignal
    ) => {
        const processedItems = await Promise.all(input.items.map(async (item) => {
            if (!item || typeof item !== 'object' || !('value' in item)) return item
            const value = (item as any).value
            if (value === undefined) return item
            const processed = await this.transform.outbound(handle, value as T)
            if (processed === undefined) {
                throw new Error('[Atoma] transform returned empty for outbound write')
            }
            return { ...(item as any), value: processed } as WriteItem
        }))

        const op: Operation = Protocol.ops.build.buildWriteOp({
            opId: handle.nextOpId('w'),
            write: {
                resource: handle.storeName,
                action: input.action,
                items: processedItems,
                ...(input.options ? { options: input.options } : {})
            }
        })
        const results = await this.executeOps({ ops: [op], context, ...(signal ? { signal } : {}) })
        const result = requireSingleResult(results, 'Missing write result')
        if (!(result as any).ok) throw toOpsError(result, 'write')

        try {
            return Protocol.ops.validate.assertWriteResultData((result as any).data) as WriteResultData
        } catch (error) {
            throw toProtocolValidationError(error, 'Invalid write result data')
        }
    }
}
