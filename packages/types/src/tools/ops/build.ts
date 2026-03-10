import type { Meta, Query, QueryOp, ResourceToken, WriteOp } from '@atoma-js/types/protocol'

export function buildWriteOp(args: {
    opId: string
    write: WriteOp['write']
    meta?: Meta
}): WriteOp {
    return {
        opId: args.opId,
        kind: 'write',
        write: args.write,
        ...(args.meta ? { meta: args.meta } : {})
    }
}

export function buildQueryOp(args: {
    opId: string
    resource: ResourceToken
    query: Query
    meta?: Meta
}): QueryOp {
    return {
        opId: args.opId,
        kind: 'query',
        query: {
            resource: args.resource,
            query: args.query
        },
        ...(args.meta ? { meta: args.meta } : {})
    }
}
