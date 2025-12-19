import type { StandardError, StandardErrorDetails } from './types'

export function create(code: string, message: string, details?: StandardErrorDetails): StandardError {
    return details ? { code, message, details } : { code, message }
}

export function withTrace(error: StandardError, meta: { traceId?: string; requestId?: string; opId?: string }) {
    const details = (error as any)?.details
    const nextDetails = (details && typeof details === 'object' && !Array.isArray(details))
        ? { ...details, ...meta }
        : { kind: 'internal', ...meta }
    return { ...error, details: nextDetails }
}

export function withDetails(error: StandardError, details: StandardErrorDetails) {
    const base = (error && typeof error === 'object') ? error : { code: 'INTERNAL', message: 'Internal error' }
    return { ...base, details }
}

export function wrap(error: unknown, fallback: { code: string; message: string; details?: StandardErrorDetails }) {
    const e: any = error
    if (e && typeof e === 'object' && typeof e.code === 'string' && typeof e.message === 'string') {
        const details = (e as any).details
        if (details === undefined) return e as StandardError
        if (details && typeof details === 'object' && !Array.isArray(details)) return e as StandardError
        return { code: e.code, message: e.message } as StandardError
    }
    return create(fallback.code, fallback.message, fallback.details)
}
