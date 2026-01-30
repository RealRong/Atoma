import type { ObservabilityContext } from 'atoma-observability'
import { Protocol, type Operation, type OperationResult, type Query, type QueryResultData, type WriteAction, type WriteItem, type WriteOptions, type WriteResultData } from 'atoma-protocol'
import type { Entity, OpsClientLike, RuntimeIo, RuntimeTransform } from '../types'
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

export function createRuntimeIo(deps: {
    opsClient: OpsClientLike
    transform: RuntimeTransform
    now?: () => number
}): RuntimeIo {
    const now = deps.now ?? (() => Date.now())

    const executeOps: RuntimeIo['executeOps'] = async (input) => {
        const context = input.context
        const traceId = (typeof context?.traceId === 'string' && context.traceId) ? context.traceId : undefined
        const opsWithTrace = Protocol.ops.build.withTraceMeta({
            ops: input.ops,
            traceId,
            ...(context ? { nextRequestId: context.requestId } : {})
        })
        const meta = Protocol.ops.build.buildRequestMeta({
            now,
            traceId,
            requestId: context ? context.requestId() : undefined
        })
        Protocol.ops.validate.assertOutgoingOps({ ops: opsWithTrace, meta })

        const res = await deps.opsClient.executeOps({
            ops: opsWithTrace,
            meta,
            ...(input.signal ? { signal: input.signal } : {}),
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
        query: Query,
        context?: ObservabilityContext,
        signal?: AbortSignal
    ) => {
        const op: Operation = Protocol.ops.build.buildQueryOp({
            opId: handle.nextOpId('q'),
            resource: handle.storeName,
            query
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
            data: Array.isArray((data as any)?.data) ? ((data as any).data as unknown[]) : [],
            pageInfo: (data as any)?.pageInfo,
            ...(data && (data as any).explain !== undefined ? { explain: (data as any).explain } : {})
        }
    }

    const write: RuntimeIo['write'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        input: { action: WriteAction; items: WriteItem[]; options?: WriteOptions },
        context?: ObservabilityContext,
        signal?: AbortSignal
    ) => {
        const processedItems = await Promise.all(input.items.map(async (item) => {
            if (!item || typeof item !== 'object' || !('value' in item)) return item
            const value = (item as any).value
            if (value === undefined) return item
            const processed = await deps.transform.outbound(handle, value as T)
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
