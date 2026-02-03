import type { ErrorKind, StandardError, StandardErrorDetails } from 'atoma-types/protocol'
import { Protocol } from 'atoma-protocol'

const ATOMA_ERROR_BRAND = Symbol.for('atoma.error')

export type AtomaErrorDetails = {
    kind: ErrorKind
    traceId?: string
    requestId?: string
    opId?: string
    resource?: string
    part?: string
    field?: string
    path?: string
    max?: number
    actual?: number
    currentValue?: unknown
    currentVersion?: number
    [k: string]: any
}

export function byteLengthUtf8(input: string) {
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(input, 'utf8')
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input).length
    return input.length
}

export class AtomaError extends Error {
    readonly code: string
    readonly details?: AtomaErrorDetails
    readonly [ATOMA_ERROR_BRAND] = true

    constructor(code: string, message: string, details?: AtomaErrorDetails) {
        super(message)
        this.name = 'AtomaError'
        this.code = code
        this.details = details
    }
}

export function isAtomaError(value: unknown): value is AtomaError {
    return Boolean(value && typeof value === 'object' && (value as any)[ATOMA_ERROR_BRAND] === true)
}

export function createError(code: string, message: string, details?: AtomaErrorDetails): AtomaError {
    return new AtomaError(code, message, details)
}

export function throwError(code: string, message: string, details?: AtomaErrorDetails): never {
    throw createError(code, message, details)
}

export function sanitizeDetails(details: unknown): AtomaErrorDetails | undefined {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined

    const kind = (details as any).kind
    if (kind !== 'validation'
        && kind !== 'auth'
        && kind !== 'limits'
        && kind !== 'conflict'
        && kind !== 'not_found'
        && kind !== 'adapter'
        && kind !== 'internal'
    ) {
        return undefined
    }

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

        if (value instanceof Error) return undefined
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
        if (byteLengthUtf8(json) > maxBytes) {
            return { kind, truncated: true } as AtomaErrorDetails
        }
        return normalized as AtomaErrorDetails
    } catch {
        return undefined
    }
}

export function toStandardError(reason: unknown, fallbackCode: string = 'INTERNAL'): StandardError {
    if (isAtomaError(reason)) {
        const details = sanitizeDetails(reason.details)
        const kind = details?.kind ?? Protocol.error.inferKindFromCode(reason.code)
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

    // Allow already-normalized StandardError to pass through (e.g. from adapter layer).
    return Protocol.error.wrap(reason, { code: fallbackCode, message: 'Internal error', kind: 'internal' })
}

export function errorStatus(error: Pick<StandardError, 'code'>) {
    switch (error.code) {
        case 'METHOD_NOT_ALLOWED':
            return 405
        case 'NOT_FOUND':
            return 404
        case 'BAD_REQUEST':
            return 400
        case 'ACCESS_DENIED':
            return 403
        case 'RESOURCE_NOT_ALLOWED':
            return 403
        case 'CONFLICT':
            return 409
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
