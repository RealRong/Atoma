import { StoreKey } from '../../core/types'

/**
 * Resolve endpoint to URL path, replacing path parameters if needed
 * Supports: '/api/todos', '/api/todos/:id', '/api/todos/{id}', or functions
 */
export function resolveEndpoint(
    endpoint: string | ((id: StoreKey) => string) | (() => string),
    id?: StoreKey
): string {
    if (typeof endpoint === 'function') {
        return endpoint(id as any)
    }

    // String endpoint - replace :id or {id} with actual id
    if (id !== undefined) {
        return endpoint
            .replace(':id', String(id))
            .replace('{id}', String(id))
    }

    return endpoint
}

export type RequestSender = (url: string, init?: RequestInit) => Promise<Response>

export function makeUrl(baseURL: string, path: string): string {
    const base = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL
    const pathStr = path.startsWith('/') ? path : `/${path}`
    return `${base}${pathStr}`
}
