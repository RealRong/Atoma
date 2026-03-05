import { wrapProtocolError, assertRemoteOpsRequest } from '@atoma-js/types/protocol-tools'
import type { Meta, Query, RemoteOpsRequest, StandardErrorDetails } from '@atoma-js/types/protocol'
import { throwError } from '../../error'
import { toObjectDetails } from '../../shared/utils/details'

type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeRemoteOpsRequest(value: unknown): RemoteOpsRequest {
    try {
        return assertRemoteOpsRequest(value)
    } catch (error) {
        const standard = wrapProtocolError(error, {
            code: 'INVALID_REQUEST',
            message: 'Invalid request',
            kind: 'validation'
        })
        const details = toObjectDetails<StandardErrorDetails>(standard.details)
        throwError(standard.code, standard.message, {
            kind: standard.kind,
            ...(details ? details as any : {})
        } as any)
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
