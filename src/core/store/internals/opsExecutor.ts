import type { ObservabilityContext } from '#observability'
import { Protocol, type Meta, type Operation, type OperationResult, type QueryParams, type QueryResultData, type WriteAction, type WriteItem, type WriteOptions, type WriteResultData } from '#protocol'
import type { Entity, StoreHandle } from '../../types'

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

export async function executeOps<T extends Entity>(handle: StoreHandle<T>, ops: Operation[], context?: ObservabilityContext): Promise<OperationResult[]> {
    const traceId = (typeof context?.traceId === 'string' && context.traceId) ? context.traceId : undefined
    const opsWithTrace = Protocol.ops.build.withTraceMeta({
        ops,
        traceId,
        ...(context ? { nextRequestId: context.requestId } : {})
    })
    const meta = Protocol.ops.build.buildRequestMeta({
        now: () => Date.now(),
        traceId,
        requestId: context ? context.requestId() : undefined
    })
    Protocol.ops.validate.assertOutgoingOpsV1({ ops: opsWithTrace, meta })
    const res = await handle.backend.opsClient.executeOps({
        ops: opsWithTrace,
        meta,
        context
    })
    return Array.isArray(res.results) ? res.results : []
}

export async function executeQuery<T extends Entity>(handle: StoreHandle<T>, params: QueryParams, context?: ObservabilityContext): Promise<{ data: unknown[]; pageInfo?: any }> {
    const op: Operation = Protocol.ops.build.buildQueryOp({
        opId: handle.nextOpId('q'),
        resource: handle.storeName,
        params
    })
    const results = await executeOps(handle, [op], context)
    const result = requireSingleResult(results, 'Missing query result')
    if (!(result as any).ok) throw toOpsError(result, 'query')
    const data = (result as any).data as QueryResultData
    return {
        data: Array.isArray((data as any)?.items) ? ((data as any).items as unknown[]) : [],
        pageInfo: (data as any)?.pageInfo
    }
}

export async function executeWrite<T extends Entity>(handle: StoreHandle<T>, args: {
    action: WriteAction
    items: WriteItem[]
    options?: WriteOptions
    context?: ObservabilityContext
}): Promise<WriteResultData> {
    const op: Operation = Protocol.ops.build.buildWriteOp({
        opId: handle.nextOpId('w'),
        write: {
            resource: handle.storeName,
            action: args.action,
            items: args.items,
            ...(args.options ? { options: args.options } : {})
        }
    })
    const results = await executeOps(handle, [op], args.context)
    const result = requireSingleResult(results, 'Missing write result')
    if (!(result as any).ok) throw toOpsError(result, 'write')
    return (result as any).data as WriteResultData
}
