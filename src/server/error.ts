import type { StandardError } from './types'

export type ErrorKind =
    | 'field_policy'
    | 'validation'
    | 'access'
    | 'limits'
    | 'adapter'
    | 'executor'
    | 'internal'

export type StandardErrorDetails = {
    kind: ErrorKind
    resource?: string
    part?: 'where' | 'orderBy' | 'select' | string
    field?: string
    path?: string
    queryIndex?: number
    requestId?: string
    max?: number
    actual?: number
    [k: string]: any
}

const ATOMA_ERROR_BRAND = Symbol.for('atoma.error')

export class AtomaError extends Error {
    readonly code: string
    readonly details?: StandardErrorDetails
    readonly [ATOMA_ERROR_BRAND] = true

    constructor(code: string, message: string, details?: StandardErrorDetails) {
        super(message)
        this.name = 'AtomaError'
        this.code = code
        this.details = details
    }
}

export function isAtomaError(value: unknown): value is AtomaError {
    return Boolean(value && typeof value === 'object' && (value as any)[ATOMA_ERROR_BRAND] === true)
}

export function createError(code: string, message: string, details?: StandardErrorDetails): AtomaError {
    return new AtomaError(code, message, details)
}

export function throwError(code: string, message: string, details?: StandardErrorDetails): never {
    throw createError(code, message, details)
}

export function sanitizeDetails(details: unknown): StandardErrorDetails | undefined {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined

    // Enforce "kind" existence and whitelist. If missing/invalid, drop details to avoid leaking.
    const kind = (details as any).kind
    if (kind !== 'field_policy'
        && kind !== 'validation'
        && kind !== 'access'
        && kind !== 'limits'
        && kind !== 'adapter'
        && kind !== 'executor'
        && kind !== 'internal'
    ) {
        return undefined
    }

    // Deep-clone into a JSON-safe plain object with size limit.
    // - removes functions/symbols
    // - breaks cycles
    // - truncates long strings
    const maxBytes = 8 * 1024
    const maxDepth = 8
    const maxString = 1024
    const seen = new WeakSet<object>()

    const clean = (value: any, depth: number): any => {
        if (value === null) return null

        const t = typeof value
        if (t === 'string') return value.length > maxString ? value.slice(0, maxString) : value
        if (t === 'number' || t === 'boolean') return value
        if (t === 'undefined') return undefined
        if (t === 'function' || t === 'symbol' || t === 'bigint') return undefined

        if (value instanceof Error) {
            // Never serialize raw Error objects.
            return undefined
        }

        if (depth >= maxDepth) return undefined

        if (Array.isArray(value)) {
            const arr: any[] = []
            for (const item of value) {
                const v = clean(item, depth + 1)
                if (v !== undefined) arr.push(v)
            }
            return arr
        }

        if (value && typeof value === 'object') {
            if (seen.has(value)) return undefined
            seen.add(value)

            const out: Record<string, any> = {}
            for (const [k, v0] of Object.entries(value)) {
                if (!k) continue
                const v = clean(v0, depth + 1)
                if (v !== undefined) out[k] = v
            }
            return out
        }

        return undefined
    }

    const normalized = clean(details, 0) as any
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) return undefined

    try {
        const json = JSON.stringify(normalized)
        if (Buffer.byteLength(json, 'utf8') > maxBytes) {
            // Hard truncate: keep kind + a marker.
            return { kind, truncated: true } as StandardErrorDetails
        }
        return normalized as StandardErrorDetails
    } catch {
        return undefined
    }
}

export function toStandardError(reason: unknown, fallbackCode: string = 'INTERNAL'): StandardError {
    if (isAtomaError(reason)) {
        const details = sanitizeDetails(reason.details)
        return details
            ? { code: reason.code, message: reason.message, details }
            : { code: reason.code, message: reason.message }
    }

    // Do not leak raw exceptions or unknown objects.
    return {
        code: fallbackCode,
        message: 'Internal error',
        details: { kind: 'internal' }
    }
}

export function errorStatus(error: Pick<StandardError, 'code'>) {
    switch (error.code) {
        case 'ACCESS_DENIED':
            return 403
        case 'RESOURCE_NOT_ALLOWED':
            return 403
        case 'ADAPTER_NOT_IMPLEMENTED':
            return 501
        case 'TOO_MANY_QUERIES':
        case 'TOO_MANY_ITEMS':
        case 'INVALID_REQUEST':
        case 'INVALID_QUERY':
        case 'INVALID_WRITE':
        case 'INVALID_PAYLOAD':
        case 'INVALID_ORDER_BY':
        case 'UNSUPPORTED_ACTION':
            return 422
        case 'PAYLOAD_TOO_LARGE':
            return 413
        default:
            return 500
    }
}

