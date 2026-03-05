import type { Envelope, Meta, StandardError } from 'atoma-types/protocol'
import { ensureMeta } from '../meta'
import { createError } from '../error/error'

const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

export function ok<T>(data: T, meta: Meta): Envelope<T> {
    return { ok: true, data, meta }
}

export function error(err: StandardError, meta: Meta): Envelope<never> {
    return { ok: false, error: err, meta }
}

export function parseEnvelope<T>(json: unknown, fallbackMeta: Meta): Envelope<T> {
    if (!isRecord(json)) {
        return {
            ok: false,
            error: createError({
                code: 'PROTOCOL_INVALID_ENVELOPE',
                message: 'Invalid envelope: expected an object',
                kind: 'validation',
                retryable: false
            }),
            meta: fallbackMeta
        }
    }

    const okValue = json.ok
    if (typeof okValue !== 'boolean') {
        return {
            ok: false,
            error: createError({
                code: 'PROTOCOL_INVALID_ENVELOPE',
                message: 'Invalid envelope: missing boolean "ok"',
                kind: 'validation',
                retryable: false
            }),
            meta: fallbackMeta
        }
    }

    const meta = ensureMeta(json.meta, fallbackMeta)

    if (okValue === true) {
        return { ok: true, data: json.data as T, meta }
    }

    const errorRaw = json.error
    const err = isRecord(errorRaw)
        ? (errorRaw as StandardError)
        : createError({ code: 'INTERNAL', message: 'Request failed', kind: 'internal', retryable: false })

    return { ok: false, error: err, meta }
}
