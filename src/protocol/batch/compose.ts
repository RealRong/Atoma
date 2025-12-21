import type {
    BatchOp,
    BatchRequest,
    BulkCreateItem,
    BulkDeleteItem,
    BulkPatchItem,
    BulkUpdateItem,
    WriteOptions
} from './types'
import type { QueryParams } from './query'

export function request(args: { ops: BatchOp[]; traceId?: string; requestId?: string }): BatchRequest {
    const traceId = typeof args.traceId === 'string' && args.traceId ? args.traceId : undefined
    const requestId = typeof args.requestId === 'string' && args.requestId ? args.requestId : undefined
    return {
        ops: Array.isArray(args.ops) ? args.ops : [],
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {})
    }
}

export function meta(args: { traceId?: string; requestId?: string }) {
    const traceId = typeof args.traceId === 'string' && args.traceId ? args.traceId : undefined
    const requestId = typeof args.requestId === 'string' && args.requestId ? args.requestId : undefined
    return {
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {})
    }
}

export function withMeta(req: BatchRequest, m: { traceId?: string; requestId?: string }): BatchRequest {
    return {
        ...req,
        ...meta(m)
    }
}

function query(args: { opId: string; resource: string; params: QueryParams }): Extract<BatchOp, { action: 'query' }> {
        const page = args.params?.page ?? { mode: 'offset', limit: 50, includeTotal: true }
        return {
            opId: args.opId,
            action: 'query',
            query: {
                resource: args.resource,
                params: {
                    ...(args.params || {}),
                    page
                }
            }
        }
}

function bulkCreate<T = any>(args: { opId: string; resource: string; payload: Array<BulkCreateItem<T>>; options?: WriteOptions }): Extract<BatchOp, { action: 'bulkCreate' }> {
        return {
            opId: args.opId,
            action: 'bulkCreate',
            resource: args.resource,
            payload: args.payload,
            ...(args.options ? { options: args.options } : {})
        }
}

function bulkUpdate<T = any>(args: { opId: string; resource: string; payload: Array<BulkUpdateItem<T>>; options?: WriteOptions }): Extract<BatchOp, { action: 'bulkUpdate' }> {
        return {
            opId: args.opId,
            action: 'bulkUpdate',
            resource: args.resource,
            payload: args.payload,
            ...(args.options ? { options: args.options } : {})
        }
}

function bulkPatch(args: { opId: string; resource: string; payload: Array<BulkPatchItem>; options?: WriteOptions }): Extract<BatchOp, { action: 'bulkPatch' }> {
        return {
            opId: args.opId,
            action: 'bulkPatch',
            resource: args.resource,
            payload: args.payload,
            ...(args.options ? { options: args.options } : {})
        }
}

function bulkDelete(args: { opId: string; resource: string; payload: Array<BulkDeleteItem>; options?: WriteOptions }): Extract<BatchOp, { action: 'bulkDelete' }> {
        return {
            opId: args.opId,
            action: 'bulkDelete',
            resource: args.resource,
            payload: args.payload,
            ...(args.options ? { options: args.options } : {})
        }
}

export const op = {
    query,
    bulkCreate,
    bulkUpdate,
    bulkPatch,
    bulkDelete
}
