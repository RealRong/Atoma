import type { Envelope } from './envelope'
import type { Meta } from './meta'
import { ensureMeta } from './meta'
import type { StandardError } from './error'
import { createError } from './error'

const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

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
    const error = isRecord(errorRaw)
        ? (errorRaw as StandardError)
        : createError({ code: 'INTERNAL', message: 'Request failed', kind: 'internal', retryable: false })

    return { ok: false, error, meta }
}

