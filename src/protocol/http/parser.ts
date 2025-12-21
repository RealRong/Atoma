import type { StandardEnvelope } from './envelope'

const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

export function parseStandardEnvelope<T>(response: Response, json: unknown): StandardEnvelope<T> {
    if (response.status === 204) {
        return { data: [] as unknown as T[] }
    }

    if (isRecord(json)) {
        if ('data' in json) {
            const obj = json as Record<string, unknown>
            return {
                data: obj.data as T | T[],
                pageInfo: obj.pageInfo as any,
                message: typeof obj.message === 'string' ? obj.message : undefined,
                code: (typeof obj.code === 'string' || typeof obj.code === 'number') ? obj.code : undefined,
                isError: obj.isError === true,
                meta: obj.meta
            }
        }

        // Legacy: { results: [...] }
        const results = (json as any).results
        if (Array.isArray(results)) {
            return {
                data: results as T[],
                pageInfo: (json as any).pageInfo as any
            }
        }

        const error = (json as any).error
        if (isRecord(error)) {
            const message = typeof error.message === 'string'
                ? error.message
                : (typeof (json as any).message === 'string' ? (json as any).message : 'Request failed')
            const code = (typeof error.code === 'string' || typeof error.code === 'number')
                ? error.code
                : undefined
            return {
                data: [] as unknown as T[],
                isError: true,
                message,
                code,
                meta: json
            }
        }
    }

    return { data: json as T }
}

