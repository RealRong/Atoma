import type { Cursor, Meta, Query, ChangesPullOp, RemoteOp, QueryOp, ResourceToken, WriteOp } from 'atoma-types/protocol'

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function buildRequestMeta(args?: {
    now?: () => number
    traceId?: string
    requestId?: string
}): Meta {
    const now = args?.now ?? (() => Date.now())
    const traceId = (typeof args?.traceId === 'string' && args.traceId) ? args.traceId : undefined
    const requestId = (typeof args?.requestId === 'string' && args.requestId) ? args.requestId : undefined

    return {
        v: 1,
        clientTimeMs: now(),
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {})
    }
}

export function withTraceMeta(args: {
    ops: RemoteOp[]
    traceId?: string
    nextRequestId?: () => string | undefined
}): RemoteOp[] {
    if (!Array.isArray(args.ops) || args.ops.length === 0) return args.ops
    const traceId = (typeof args.traceId === 'string' && args.traceId) ? args.traceId : undefined
    if (!traceId) return args.ops

    return args.ops.map((op) => {
        if (!op || typeof op !== 'object') return op

        const baseMeta = (op as any).meta
        const meta = isPlainObject(baseMeta) ? (baseMeta as Record<string, unknown>) : undefined
        const requestId = args.nextRequestId ? args.nextRequestId() : undefined

        return {
            ...(op as any),
            meta: {
                v: 1,
                ...(meta ? meta : {}),
                traceId,
                ...(requestId ? { requestId } : {})
            }
        } as RemoteOp
    })
}

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

export function buildChangesPullOp(args: {
    opId: string
    cursor: Cursor
    limit: number
    resources?: ResourceToken[]
    meta?: Meta
}): ChangesPullOp {
    return {
        opId: args.opId,
        kind: 'changes.pull',
        pull: {
            cursor: args.cursor,
            limit: args.limit,
            ...(args.resources ? { resources: args.resources } : {})
        },
        ...(args.meta ? { meta: args.meta } : {})
    }
}
