import type { Meta } from '../meta'
import type { StandardError } from '../error'
import type { Envelope } from './types'

export function ok<T>(data: T, meta: Meta): Envelope<T> {
    return { ok: true, data, meta }
}

export function error(err: StandardError, meta: Meta): Envelope<never> {
    return { ok: false, error: err, meta }
}

