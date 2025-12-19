import type { StandardError } from '../error/types'

export type Ok<T> = { ok: true; value: T }
export type Err = { ok: false; error: StandardError; status?: number }
export type Result<T> = Ok<T> | Err

export function ok<T>(value: T): Ok<T> {
    return { ok: true, value }
}

export function err(error: StandardError, status?: number): Err {
    return { ok: false, error, ...(typeof status === 'number' ? { status } : {}) }
}
