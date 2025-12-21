import type { StandardEnvelope } from './envelope'

const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

export function parseStandardEnvelope<T>(response: Response, json: unknown): StandardEnvelope<T> {
    if (response.status === 204) {
        return { ok: true, data: null }
    }

    if (isRecord(json)) {
        if (typeof (json as any).ok === 'boolean') {
            const ok = (json as any).ok === true
            if (!ok) {
                const error = isRecord((json as any).error) ? (json as any).error : { code: 'INTERNAL', message: 'Request failed' }
                return { ok: false, error: error as any, meta: (json as any).meta }
            }
            return {
                ok: true,
                data: (json as any).data as any,
                pageInfo: (json as any).pageInfo as any,
                meta: (json as any).meta
            }
        }

        if ('data' in json) {
            const obj = json as Record<string, unknown>
            return {
                ok: true,
                data: obj.data as any,
                pageInfo: obj.pageInfo as any,
                meta: obj.meta
            }
        }

        // Legacy: { results: [...] }
        const results = (json as any).results
        if (Array.isArray(results)) {
            return {
                ok: true,
                data: results as any,
                pageInfo: (json as any).pageInfo as any,
                meta: (json as any).meta
            }
        }

        const error = (json as any).error
        if (isRecord(error)) {
            return {
                ok: false,
                error: error as any,
                meta: (json as any).meta ?? json
            }
        }
    }

    return { ok: true, data: json as any }
}
