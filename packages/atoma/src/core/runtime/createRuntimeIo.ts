import type { ObservabilityContext } from '#observability'
import { Protocol, type Operation, type OperationResult, type QueryParams, type QueryResultData, type WriteAction, type WriteItem, type WriteOptions, type WriteResultData } from '#protocol'
import type { CoreRuntime, Entity, RuntimeIo } from '../types'
import type { StoreHandle } from '../store/internals/handleTypes'

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

export function createRuntimeIo(runtime: () => CoreRuntime, opts?: Readonly<{ now?: () => number }>): RuntimeIo {
    const now = opts?.now ?? (() => Date.now())

    const executeOps: RuntimeIo['executeOps'] = async (args) => {
        const context = args.context
        const traceId = (typeof context?.traceId === 'string' && context.traceId) ? context.traceId : undefined
        const opsWithTrace = Protocol.ops.build.withTraceMeta({
            ops: args.ops,
            traceId,
            ...(context ? { nextRequestId: context.requestId } : {})
        })
        const meta = Protocol.ops.build.buildRequestMeta({
            now,
            traceId,
            requestId: context ? context.requestId() : undefined
        })
        Protocol.ops.validate.assertOutgoingOps({ ops: opsWithTrace, meta })

        const res = await runtime().opsClient.executeOps({
            ops: opsWithTrace,
            meta,
            ...(args.signal ? { signal: args.signal } : {}),
            ...(context ? { context } : {})
        } as any)

        try {
            return Protocol.ops.validate.assertOperationResults((res as any).results)
        } catch (error) {
            throw toProtocolValidationError(error, 'Invalid ops response')
        }
    }

    const query: RuntimeIo['query'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        params: QueryParams,
        context?: ObservabilityContext,
        signal?: AbortSignal
    ) => {
        const op: Operation = Protocol.ops.build.buildQueryOp({
            opId: handle.nextOpId('q'),
            resource: handle.storeName,
            params
        })
        const results = await executeOps({ ops: [op], context, ...(signal ? { signal } : {}) })
        const result = requireSingleResult(results, 'Missing query result')
        if (!(result as any).ok) throw toOpsError(result, 'query')

        let data: QueryResultData
        try {
            data = Protocol.ops.validate.assertQueryResultData((result as any).data) as QueryResultData
        } catch (error) {
            throw toProtocolValidationError(error, 'Invalid query result data')
        }

        return {
            data: Array.isArray((data as any)?.items) ? ((data as any).items as unknown[]) : [],
            pageInfo: (data as any)?.pageInfo
        }
    }

    const write: RuntimeIo['write'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        args: { action: WriteAction; items: WriteItem[]; options?: WriteOptions },
        context?: ObservabilityContext,
        signal?: AbortSignal
    ) => {
        const processedItems = await Promise.all(args.items.map(async (item) => {
            if (!item || typeof item !== 'object' || !('value' in item)) return item
            const value = (item as any).value
            if (value === undefined) return item
            const processed = await runtime().dataProcessor.outbound(handle, value as T)
            if (processed === undefined) {
                throw new Error('[Atoma] dataProcessor returned empty for outbound write')
            }
            return { ...(item as any), value: processed } as WriteItem
        }))

        const op: Operation = Protocol.ops.build.buildWriteOp({
            opId: handle.nextOpId('w'),
            write: {
                resource: handle.storeName,
                action: args.action,
                items: processedItems,
                ...(args.options ? { options: args.options } : {})
            }
        })
        const results = await executeOps({ ops: [op], context, ...(signal ? { signal } : {}) })
        const result = requireSingleResult(results, 'Missing write result')
        if (!(result as any).ok) throw toOpsError(result, 'write')

        try {
            return Protocol.ops.validate.assertWriteResultData((result as any).data) as WriteResultData
        } catch (error) {
            throw toProtocolValidationError(error, 'Invalid write result data')
        }
    }

    return {
        executeOps,
        query,
        write
    }
}

