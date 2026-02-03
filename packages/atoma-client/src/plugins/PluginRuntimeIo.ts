import { Protocol } from 'atoma-protocol'
import type { Types } from 'atoma-core'
import type { RuntimeIo, StoreHandle } from 'atoma-runtime'
import type { HandlerChain } from './HandlerChain'
import type { IoContext, QueryResult, ReadContext, ReadRequest } from './types'

export class PluginRuntimeIo implements RuntimeIo {
    private readonly ioChain: HandlerChain
    private readonly readChain: HandlerChain
    private readonly now: () => number
    private readonly clientId: string

    constructor(args: {
        io: HandlerChain
        read: HandlerChain
        now?: () => number
        clientId: string
    }) {
        this.ioChain = args.io
        this.readChain = args.read
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

    query: RuntimeIo['query'] = async <T extends Types.Entity>(
        handle: StoreHandle<T>,
        query: Types.Query,
        context?: Types.ObservabilityContext,
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
