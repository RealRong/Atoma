import { StoreKey } from '../../core/types'

export type RequestSender = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Resolve endpoint to URL path, supports:
 * - String: '/api/todos'
 * - Template: '/api/todos/:id' or '/api/todos/{id}'
 * - Function: (id) => `/api/todos/${id}`
 */
export function resolveEndpoint(
    endpoint: string | ((id: StoreKey) => string) | (() => string),
    id?: StoreKey
): string {
    if (typeof endpoint === 'function') {
        // Type narrowing: endpoint is a function
        return (endpoint as any)(id)
    }

    // String endpoint - replace :id or {id} with actual id
    if (id !== undefined) {
        return endpoint
            .replace(':id', String(id))
            .replace('{id}', String(id))
    }

    return endpoint
}

export async function fetchJson(sender: RequestSender, url: string, init?: RequestInit): Promise<any> {
    const res = await sender(url, init)
    return res.json()
}

export function withJson(body: any, headers: Record<string, string> = {}): RequestInit {
    return {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }
}

export type UrlBuilder = (...args: any[]) => string

export function makeUrl(base: string, path: string): string {
    return `${base}${path}`
}

export async function sendJson(
    sender: RequestSender,
    url: string,
    body: any,
    headers: Record<string, string>
): Promise<Response> {
    return sender(url, withJson(body, headers))
}

export async function sendDelete(
    sender: RequestSender,
    url: string,
    headers: Record<string, string>
): Promise<Response> {
    return sender(url, { method: 'DELETE', headers })
}

export async function sendDeleteJson(
    sender: RequestSender,
    url: string,
    body: any,
    headers: Record<string, string>
): Promise<Response> {
    return sender(url, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
}

export async function sendPutJson(
    sender: RequestSender,
    url: string,
    body: any,
    headers: Record<string, string>
): Promise<Response> {
    return sender(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
}
