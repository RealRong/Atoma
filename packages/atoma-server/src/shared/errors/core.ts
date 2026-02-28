import type { ErrorKind } from 'atoma-types/protocol'

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
    [key: string]: any
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
