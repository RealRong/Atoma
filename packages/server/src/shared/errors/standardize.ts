import type { ErrorKind, StandardError, StandardErrorDetails } from '@atoma-js/types/protocol'
import { isAtomaError } from './core'
import { sanitizeDetails } from './sanitizeDetails'

function inferKindFromCode(code: string): ErrorKind {
    switch (code) {
        case 'NOT_FOUND':
            return 'not_found'
        case 'CONFLICT':
            return 'conflict'
        case 'ACCESS_DENIED':
        case 'RESOURCE_NOT_ALLOWED':
            return 'auth'
        case 'TOO_MANY_QUERIES':
        case 'TOO_MANY_ITEMS':
        case 'PAYLOAD_TOO_LARGE':
            return 'limits'
        default:
            if (
                code === 'INVALID_REQUEST'
                || code === 'INVALID_QUERY'
                || code === 'INVALID_WRITE'
                || code === 'INVALID_PAYLOAD'
                || code === 'INVALID_ORDER_BY'
                || code === 'METHOD_NOT_ALLOWED'
                || code === 'PROTOCOL_UNSUPPORTED_VERSION'
                || code === 'PROTOCOL_INVALID_ENVELOPE'
                || code.startsWith('INVALID_')
                || code.startsWith('PROTOCOL_')
            ) {
                return 'validation'
            }
            return 'internal'
    }
}

function wrapToStandardError(reason: unknown, fallback: {
    code: string
    message: string
    kind?: ErrorKind
    details?: StandardErrorDetails
}): StandardError {
    const error = reason as any
    if (
        error
        && typeof error === 'object'
        && typeof error.code === 'string'
        && typeof error.message === 'string'
        && typeof error.kind === 'string'
    ) {
        const details = (error as any).details
        if (details === undefined) return error as StandardError
        if (details && typeof details === 'object' && !Array.isArray(details)) return error as StandardError
        return { code: error.code, message: error.message, kind: error.kind } as StandardError
    }

    return {
        code: fallback.code,
        message: fallback.message,
        kind: fallback.kind ?? inferKindFromCode(fallback.code),
        ...(fallback.details ? { details: fallback.details } : {})
    }
}

export { sanitizeDetails }

export function toStandardError(reason: unknown, fallbackCode: string = 'INTERNAL'): StandardError {
    if (isAtomaError(reason)) {
        const details = sanitizeDetails(reason.details)
        const kind = details?.kind ?? inferKindFromCode(reason.code)
        if (!details) {
            return { code: reason.code, message: reason.message, kind }
        }

        const { kind: _kind, ...rest } = details
        const outDetails = Object.keys(rest).length ? (rest as unknown as StandardErrorDetails) : undefined
        return {
            code: reason.code,
            message: reason.message,
            kind,
            ...(outDetails ? { details: outDetails } : {})
        }
    }

    return wrapToStandardError(reason, {
        code: fallbackCode,
        message: 'Internal error',
        kind: 'internal'
    })
}
