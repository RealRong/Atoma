import type { Meta } from '../meta'
import type { StandardError } from '../error'

export type EnvelopeOk<T> = {
    ok: true
    data: T
    meta: Meta
}

export type EnvelopeErr = {
    ok: false
    error: StandardError
    meta: Meta
}

export type Envelope<T> = EnvelopeOk<T> | EnvelopeErr

