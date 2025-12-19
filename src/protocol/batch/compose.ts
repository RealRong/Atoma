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

export const op = {
    query: (args: { opId: string; resource: string; params: QueryParams }): Extract<BatchOp, { action: 'query' }> => {
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
    },

    bulkCreate: <T = any>(args: { opId: string; resource: string; payload: Array<BulkCreateItem<T>>; options?: WriteOptions }) => {
        return {
            opId: args.opId,
            action: 'bulkCreate',
            resource: args.resource,
            payload: args.payload as any,
            ...(args.options ? { options: args.options } : {})
        } as Extract<BatchOp, { action: 'bulkCreate' }>
    },

    bulkUpdate: <T = any>(args: { opId: string; resource: string; payload: Array<BulkUpdateItem<T>>; options?: WriteOptions }) => {
        return {
            opId: args.opId,
            action: 'bulkUpdate',
            resource: args.resource,
            payload: args.payload as any,
            ...(args.options ? { options: args.options } : {})
        } as Extract<BatchOp, { action: 'bulkUpdate' }>
    },

    bulkPatch: (args: { opId: string; resource: string; payload: Array<BulkPatchItem>; options?: WriteOptions }) => {
        return {
            opId: args.opId,
            action: 'bulkPatch',
            resource: args.resource,
            payload: args.payload as any,
            ...(args.options ? { options: args.options } : {})
        } as Extract<BatchOp, { action: 'bulkPatch' }>
    },

    bulkDelete: (args: { opId: string; resource: string; payload: Array<BulkDeleteItem>; options?: WriteOptions }) => {
        return {
            opId: args.opId,
            action: 'bulkDelete',
            resource: args.resource,
            payload: args.payload as any,
            ...(args.options ? { options: args.options } : {})
        } as Extract<BatchOp, { action: 'bulkDelete' }>
    }
} as const
