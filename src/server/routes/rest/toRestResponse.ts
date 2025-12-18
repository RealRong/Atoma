import { errorStatus } from '../../error'
import type { BatchRequest } from '../../types'

export function toRestResponse(
    route: { kind: 'rest'; id?: string; method: string },
    req: BatchRequest,
    res: any
): { status: number; body: any } {
    const first = Array.isArray(res.results) ? res.results[0] : undefined
    if (!first) {
        return { status: 500, body: { error: { code: 'INTERNAL', message: 'Empty result' } } }
    }

    if (first.ok === false || first.error) {
        const error = first.error ?? { code: 'INTERNAL', message: 'Internal error' }
        const status = errorStatus(error)
        const details = (error as any)?.details
        const currentValue = details && typeof details === 'object' ? (details as any).currentValue : undefined
        const currentVersion = details && typeof details === 'object' ? (details as any).currentVersion : undefined
        if (error.code === 'CONFLICT') {
            return {
                status,
                body: {
                    error,
                    ...(currentValue !== undefined ? { currentValue } : {}),
                    ...(typeof currentVersion === 'number' ? { currentVersion } : {})
                }
            }
        }
        return { status, body: { error } }
    }

    const method = (route.method || '').toUpperCase()

    if (method === 'GET') {
        if (route.id !== undefined) {
            const item = Array.isArray(first.data) ? first.data[0] : undefined
            if (!item) {
                return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found' } } }
            }
            return { status: 200, body: { data: item } }
        }
        return { status: 200, body: { data: first.data ?? [], pageInfo: first.pageInfo } }
    }

    if (method === 'DELETE') {
        if (Array.isArray(first.partialFailures) && first.partialFailures.length) {
            const error = first.partialFailures[0].error
            return { status: errorStatus(error), body: { error } }
        }
        return { status: 204, body: undefined }
    }

    if (Array.isArray(first.partialFailures) && first.partialFailures.length) {
        const error = first.partialFailures[0].error
        return { status: errorStatus(error), body: { error } }
    }

    const item = Array.isArray(first.data) ? first.data[0] : undefined
    const status = method === 'POST' ? 201 : 200
    return { status, body: { data: item ?? null } }
}

