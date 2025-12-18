import { throwError } from '../error'

export type {
    SyncPushOp,
    SyncPushRequest,
    SyncPushAck,
    SyncPushReject,
    SyncPushResponse
} from '../../protocol/sync'

import type { SyncPushOp, SyncPushRequest } from '../../protocol/sync'

export function validateSyncPullQuery(args: { cursor: any; limit: any; defaultLimit: number; maxLimit: number }) {
    const cursorRaw = args.cursor
    const cursor = (() => {
        if (cursorRaw === undefined || cursorRaw === null || cursorRaw === '') return 0
        const n = Number(cursorRaw)
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN
    })()
    if (!Number.isFinite(cursor)) {
        throwError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation', path: 'cursor' })
    }

    const limitRaw = args.limit
    const limit = (() => {
        if (limitRaw === undefined || limitRaw === null || limitRaw === '') return args.defaultLimit
        const n = Number(limitRaw)
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : NaN
    })()
    if (!Number.isFinite(limit)) {
        throwError('INVALID_REQUEST', 'Invalid limit', { kind: 'validation', path: 'limit' })
    }

    const finalLimit = Math.min(limit, args.maxLimit)
    return { cursor, limit: finalLimit }
}

export function validateSyncSubscribeQuery(args: { cursor: any }) {
    const cursorRaw = args.cursor
    const cursor = (() => {
        if (cursorRaw === undefined || cursorRaw === null || cursorRaw === '') return 0
        const n = Number(cursorRaw)
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN
    })()
    if (!Number.isFinite(cursor)) {
        throwError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation', path: 'cursor' })
    }
    return { cursor }
}

export function validateSyncPushRequest(body: any): SyncPushRequest {
    const traceId = typeof body?.traceId === 'string' && body.traceId ? body.traceId : undefined
    const requestId = typeof body?.requestId === 'string' && body.requestId ? body.requestId : undefined
    const traceMeta = {
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {})
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throwError('INVALID_REQUEST', 'Invalid sync push payload', { kind: 'validation', path: 'body', ...traceMeta })
    }

    const opsRaw = (body as any).ops
    if (!Array.isArray(opsRaw)) {
        throwError('INVALID_REQUEST', 'Invalid sync push ops', { kind: 'validation', path: 'ops', ...traceMeta })
    }

    const ops: SyncPushOp[] = opsRaw.map((op: any, index: number) => {
        if (!op || typeof op !== 'object' || Array.isArray(op)) {
            throwError('INVALID_REQUEST', 'Invalid sync op', { kind: 'validation', path: `ops[${index}]`, ...traceMeta })
        }

        const idempotencyKey = op.idempotencyKey
        if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
            throwError('INVALID_REQUEST', 'Invalid idempotencyKey', { kind: 'validation', path: `ops[${index}].idempotencyKey`, ...traceMeta })
        }

        const resource = op.resource
        if (typeof resource !== 'string' || !resource) {
            throwError('INVALID_REQUEST', 'Invalid resource', { kind: 'validation', path: `ops[${index}].resource`, ...traceMeta })
        }

        const kind = op.kind
        if (kind !== 'create' && kind !== 'patch' && kind !== 'delete') {
            throwError('INVALID_REQUEST', 'Invalid kind', { kind: 'validation', path: `ops[${index}].kind`, ...traceMeta })
        }

        const timestamp = op.timestamp
        if (timestamp !== undefined && !(typeof timestamp === 'number' && Number.isFinite(timestamp))) {
            throwError('INVALID_REQUEST', 'Invalid timestamp', { kind: 'validation', path: `ops[${index}].timestamp`, ...traceMeta })
        }

        if (kind === 'create') {
            if (!('data' in op)) {
                throwError('INVALID_REQUEST', 'Missing data', { kind: 'validation', path: `ops[${index}].data`, ...traceMeta })
            }
            return {
                opId: typeof op.opId === 'string' ? op.opId : undefined,
                idempotencyKey,
                resource,
                kind: 'create',
                id: op.id,
                timestamp,
                data: op.data
            }
        }

        const id = op.id
        if (id === undefined || id === null) {
            throwError('INVALID_REQUEST', 'Missing id', { kind: 'validation', path: `ops[${index}].id`, ...traceMeta })
        }

        const baseVersion = op.baseVersion
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion >= 0)) {
            throwError('INVALID_REQUEST', 'Invalid baseVersion', { kind: 'validation', path: `ops[${index}].baseVersion`, ...traceMeta })
        }

        if (kind === 'patch') {
            const patches = op.patches
            if (!Array.isArray(patches)) {
                throwError('INVALID_REQUEST', 'Invalid patches', { kind: 'validation', path: `ops[${index}].patches`, ...traceMeta })
            }
            return {
                opId: typeof op.opId === 'string' ? op.opId : undefined,
                idempotencyKey,
                resource,
                kind: 'patch',
                id,
                baseVersion,
                timestamp,
                patches
            }
        }

        return {
            opId: typeof op.opId === 'string' ? op.opId : undefined,
            idempotencyKey,
            resource,
            kind: 'delete',
            id,
            baseVersion,
            timestamp
        }
    })

    return {
        deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined,
        traceId,
        requestId,
        ops
    }
}
