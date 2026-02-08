import { throwError } from '../../error'
import { wrapProtocolError, assertOpsRequest, assertOperation } from 'atoma-types/protocol-tools'
import type { Meta, Operation, OpsRequest, StandardErrorDetails } from 'atoma-types/protocol'
import type { Query } from 'atoma-types/protocol'

type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toThrowDetails(details: unknown): StandardErrorDetails | undefined {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
    return details as StandardErrorDetails
}

export function normalizeOpsRequest(value: unknown): OpsRequest {
    try {
        return assertOpsRequest(value)
    } catch (err) {
        const standard = wrapProtocolError(err, { code: 'INVALID_REQUEST', message: 'Invalid request', kind: 'validation' })
        const details = toThrowDetails(standard.details)
        throwError(standard.code, standard.message, { kind: standard.kind, ...(details ? details as any : {}) } as any)
    }
}

export function normalizeOperation(value: unknown): Operation {
    try {
        return assertOperation(value)
    } catch (err) {
        const standard = wrapProtocolError(err, { code: 'INVALID_REQUEST', message: 'Invalid op', kind: 'validation' })
        const details = toThrowDetails(standard.details)
        throwError(standard.code, standard.message, { kind: standard.kind, ...(details ? details as any : {}) } as any)
    }
}

export function ensureProtocolVersion(meta: Meta) {
    if (meta.v === 1) return
    throwError('PROTOCOL_UNSUPPORTED_VERSION', 'Unsupported protocol version', {
        kind: 'validation',
        supported: [1],
        received: meta.v
    })
}

export function clampQueryLimit(query: Query, maxLimit: number) {
    if (!query?.page) return
    const page = query.page as any
    if (typeof page.limit === 'number' && page.limit > maxLimit) {
        page.limit = maxLimit
    }
}

export function parseCursor(cursor: string): number {
    if (!cursor.match(/^[0-9]+$/)) {
        throwError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation' })
    }
    const n = Number(cursor)
    if (!Number.isFinite(n) || n < 0) {
        throwError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation' })
    }
    return n
}
