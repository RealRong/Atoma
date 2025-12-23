import type { ErrorKind, StandardError, StandardErrorDetails } from './types'

export function createError(args: {
    code: string
    message: string
    kind: ErrorKind
    retryable?: boolean
    details?: StandardErrorDetails
    cause?: StandardError
}): StandardError {
    return {
        code: args.code,
        message: args.message,
        kind: args.kind,
        retryable: args.retryable,
        details: args.details,
        cause: args.cause
    }
}

export function inferKindFromCode(code: string): ErrorKind {
    switch (code) {
        case 'NOT_FOUND':
            return 'not_found'
        case 'CONFLICT':
            return 'conflict'
        case 'ACCESS_DENIED':
        case 'RESOURCE_NOT_ALLOWED':
            return 'auth'
        case 'INVALID_REQUEST':
        case 'INVALID_QUERY':
        case 'INVALID_WRITE':
        case 'INVALID_PAYLOAD':
        case 'INVALID_ORDER_BY':
        case 'METHOD_NOT_ALLOWED':
        case 'PROTOCOL_UNSUPPORTED_VERSION':
        case 'PROTOCOL_INVALID_ENVELOPE':
            return 'validation'
        case 'TOO_MANY_QUERIES':
        case 'TOO_MANY_ITEMS':
        case 'PAYLOAD_TOO_LARGE':
            return 'limits'
        default:
            return 'internal'
    }
}

export function create(code: string, message: string, details?: StandardErrorDetails): StandardError {
    return {
        code,
        message,
        kind: inferKindFromCode(code),
        ...(details ? { details } : {})
    }
}

export function withTrace(error: StandardError, meta: { traceId?: string; requestId?: string; opId?: string }) {
    const details = (error as any)?.details
    const nextDetails = (details && typeof details === 'object' && !Array.isArray(details))
        ? { ...details, ...meta }
        : { ...meta }
    return { ...error, details: nextDetails }
}

export function withDetails(error: StandardError, details: StandardErrorDetails) {
    const base = (error && typeof error === 'object') ? error : create('INTERNAL', 'Internal error')
    return { ...base, details }
}

export function wrap(error: unknown, fallback: { code: string; message: string; kind?: ErrorKind; details?: StandardErrorDetails }) {
    const e: any = error
    if (e && typeof e === 'object'
        && typeof e.code === 'string'
        && typeof e.message === 'string'
        && typeof e.kind === 'string'
    ) {
        const details = (e as any).details
        if (details === undefined) return e as StandardError
        if (details && typeof details === 'object' && !Array.isArray(details)) return e as StandardError
        return { code: e.code, message: e.message, kind: e.kind } as StandardError
    }
    return createError({
        code: fallback.code,
        message: fallback.message,
        kind: fallback.kind ?? inferKindFromCode(fallback.code),
        details: fallback.details
    })
}

