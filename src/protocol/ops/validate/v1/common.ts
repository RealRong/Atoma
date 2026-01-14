import type { StandardError } from '../../../core/error'
import { create as createStandardError } from '../../../core/error/error'

export type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return isObject(value)
}

export function invalid(code: string, message: string, details?: Record<string, unknown>): StandardError {
    return createStandardError(code, message, details)
}

export function readString(obj: JsonObject, key: string): string | undefined {
    const v = obj[key]
    return typeof v === 'string' ? v : undefined
}

export function readNumber(obj: JsonObject, key: string): number | undefined {
    const v = obj[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function assertNonEmptyString(value: unknown, err: { code: string; message: string; details?: Record<string, unknown> }): string {
    if (typeof value !== 'string' || !value) throw invalid(err.code, err.message, err.details)
    return value
}

export function assertFiniteNumber(value: unknown, err: { code: string; message: string; details?: Record<string, unknown> }): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(err.code, err.message, err.details)
    return value
}

export function assertPositiveVersion(value: unknown, err: { code: string; message: string; details?: Record<string, unknown> }): number {
    const n = assertFiniteNumber(value, err)
    if (n <= 0) throw invalid(err.code, err.message, err.details)
    return n
}

