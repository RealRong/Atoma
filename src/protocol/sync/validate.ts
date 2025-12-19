import type { SyncPushOp, SyncPushRequest } from './types'
import { create as createError } from '../error/fns'
import type { Result } from '../shared/result'
import { ok, err } from '../shared/result'

export function validatePullQuery(args: { cursor: any; limit: any; defaultLimit: number; maxLimit: number }): Result<{ cursor: number; limit: number }> {
    const cursorRaw = args.cursor
    const cursor = (() => {
        if (cursorRaw === undefined || cursorRaw === null || cursorRaw === '') return 0
        const n = Number(cursorRaw)
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN
    })()
    if (!Number.isFinite(cursor)) {
        return err(createError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation', path: 'cursor' }), 422)
    }

    const limitRaw = args.limit
    const limit = (() => {
        if (limitRaw === undefined || limitRaw === null || limitRaw === '') return args.defaultLimit
        const n = Number(limitRaw)
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : NaN
    })()
    if (!Number.isFinite(limit)) {
        return err(createError('INVALID_REQUEST', 'Invalid limit', { kind: 'validation', path: 'limit' }), 422)
    }

    const finalLimit = Math.min(limit, args.maxLimit)
    return ok({ cursor, limit: finalLimit })
}

export function validateSubscribeQuery(args: { cursor: any }): Result<{ cursor: number }> {
    const cursorRaw = args.cursor
    const cursor = (() => {
        if (cursorRaw === undefined || cursorRaw === null || cursorRaw === '') return 0
        const n = Number(cursorRaw)
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN
    })()
    if (!Number.isFinite(cursor)) {
        return err(createError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation', path: 'cursor' }), 422)
    }
    return ok({ cursor })
}

export function validatePushRequest(body: unknown): Result<SyncPushRequest> {
    const b: any = body
    const traceId = typeof b?.traceId === 'string' && b.traceId ? b.traceId : undefined
    const requestId = typeof b?.requestId === 'string' && b.requestId ? b.requestId : undefined
    const traceMeta = {
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {})
    }

    if (!b || typeof b !== 'object' || Array.isArray(b)) {
        return err(createError('INVALID_REQUEST', 'Invalid sync push payload', { kind: 'validation', path: 'body', ...traceMeta }), 422)
    }

    const opsRaw = b.ops
    if (!Array.isArray(opsRaw)) {
        return err(createError('INVALID_REQUEST', 'Invalid sync push ops', { kind: 'validation', path: 'ops', ...traceMeta }), 422)
    }

    const ops: SyncPushOp[] = []

    for (let index = 0; index < opsRaw.length; index++) {
        const op: any = opsRaw[index]
        if (!op || typeof op !== 'object' || Array.isArray(op)) {
            return err(createError('INVALID_REQUEST', 'Invalid sync op', { kind: 'validation', path: `ops[${index}]`, ...traceMeta }), 422)
        }

        const idempotencyKey = op.idempotencyKey
        if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
            return err(createError('INVALID_REQUEST', 'Invalid idempotencyKey', { kind: 'validation', path: `ops[${index}].idempotencyKey`, ...traceMeta }), 422)
        }

        const resource = op.resource
        if (typeof resource !== 'string' || !resource) {
            return err(createError('INVALID_REQUEST', 'Invalid resource', { kind: 'validation', path: `ops[${index}].resource`, ...traceMeta }), 422)
        }

        const kind = op.kind
        if (kind !== 'create' && kind !== 'patch' && kind !== 'delete') {
            return err(createError('INVALID_REQUEST', 'Invalid kind', { kind: 'validation', path: `ops[${index}].kind`, ...traceMeta }), 422)
        }

        const timestamp = op.timestamp
        if (timestamp !== undefined && !(typeof timestamp === 'number' && Number.isFinite(timestamp))) {
            return err(createError('INVALID_REQUEST', 'Invalid timestamp', { kind: 'validation', path: `ops[${index}].timestamp`, ...traceMeta }), 422)
        }

        if (kind === 'create') {
            if (!('data' in op)) {
                return err(createError('INVALID_REQUEST', 'Missing data', { kind: 'validation', path: `ops[${index}].data`, ...traceMeta }), 422)
            }
            ops.push({
                opId: typeof op.opId === 'string' ? op.opId : undefined,
                idempotencyKey,
                resource,
                kind: 'create',
                id: op.id,
                timestamp,
                data: op.data
            })
            continue
        }

        const id = op.id
        if (id === undefined || id === null) {
            return err(createError('INVALID_REQUEST', 'Missing id', { kind: 'validation', path: `ops[${index}].id`, ...traceMeta }), 422)
        }

        const baseVersion = op.baseVersion
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion >= 0)) {
            return err(createError('INVALID_REQUEST', 'Invalid baseVersion', { kind: 'validation', path: `ops[${index}].baseVersion`, ...traceMeta }), 422)
        }

        if (kind === 'patch') {
            const patches = op.patches
            if (!Array.isArray(patches)) {
                return err(createError('INVALID_REQUEST', 'Invalid patches', { kind: 'validation', path: `ops[${index}].patches`, ...traceMeta }), 422)
            }
            ops.push({
                opId: typeof op.opId === 'string' ? op.opId : undefined,
                idempotencyKey,
                resource,
                kind: 'patch',
                id,
                baseVersion,
                timestamp,
                patches
            } as any)
            continue
        }

        ops.push({
            opId: typeof op.opId === 'string' ? op.opId : undefined,
            idempotencyKey,
            resource,
            kind: 'delete',
            id,
            baseVersion,
            timestamp
        })
    }

    return ok({
        deviceId: typeof b.deviceId === 'string' ? b.deviceId : undefined,
        traceId,
        requestId,
        ops
    })
}
