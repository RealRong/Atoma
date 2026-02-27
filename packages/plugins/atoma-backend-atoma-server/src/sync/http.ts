import { fetchWithRetry, hasHeader, isRecord, joinUrl } from 'atoma-shared'
import type { Envelope, RemoteOpsResponseData } from 'atoma-types/protocol'
import type { AtomaServerBackendPluginOptions } from '../types'

export async function postJson<T>(args: {
    path: string
    request: unknown
    baseURL: string
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    headers?: AtomaServerBackendPluginOptions['headers']
    retry?: AtomaServerBackendPluginOptions['retry']
    onRequest?: AtomaServerBackendPluginOptions['onRequest']
    onResponse?: AtomaServerBackendPluginOptions['onResponse']
    parser: (payload: unknown) => T
}): Promise<T> {
    const headers = await resolveHeaders(args.headers)
    if (!hasHeader(headers, 'content-type')) {
        headers['content-type'] = 'application/json; charset=utf-8'
    }
    let request = new Request(joinUrl(args.baseURL, args.path), {
        method: 'POST',
        headers,
        body: JSON.stringify(args.request)
    })
    if (typeof args.onRequest === 'function') {
        const nextRequest = await args.onRequest(request)
        if (nextRequest instanceof Request) {
            request = nextRequest
        }
    }

    const response = await fetchWithRetry({
        fetchFn: args.fetchFn,
        input: request,
        retry: args.retry
    })
    const payload = await readJson(response)

    if (typeof args.onResponse === 'function') {
        args.onResponse({
            response,
            request,
            envelope: createSyncEnvelope({
                status: response.status,
                payload
            })
        })
    }

    if (!response.ok) {
        throw new Error(`[Sync] request failed: HTTP ${response.status}`)
    }

    return args.parser(payload)
}

export function resolveFetch(
    fetchFn: AtomaServerBackendPluginOptions['fetchFn']
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    if (typeof fetchFn === 'function') {
        return fetchFn
    }

    if (typeof globalThis.fetch === 'function') {
        return globalThis.fetch.bind(globalThis)
    }

    throw new Error('[Sync] fetch is not available')
}

async function resolveHeaders(
    provider: AtomaServerBackendPluginOptions['headers']
): Promise<Record<string, string>> {
    if (!provider) return {}

    const value = await provider()
    if (!isRecord(value)) return {}

    const headers: Record<string, string> = {}
    for (const [key, raw] of Object.entries(value)) {
        if (!key) continue
        if (raw === undefined || raw === null) continue
        headers[String(key)] = String(raw)
    }
    return headers
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!text.trim()) return {}

    try {
        return JSON.parse(text)
    } catch {
        throw new Error('[Sync] response body is not valid JSON')
    }
}

function createSyncEnvelope(args: {
    status: number
    payload: unknown
}): Envelope<RemoteOpsResponseData> {
    if (args.status >= 200 && args.status < 300) {
        return {
            ok: true,
            data: { results: [] },
            meta: {
                v: 1
            }
        }
    }

    return {
        ok: false,
        error: {
            code: `SYNC_HTTP_${args.status}`,
            message: `[Sync] request failed: HTTP ${args.status}`,
            kind: 'internal',
            ...(isRecord(args.payload)
                ? {
                    details: args.payload
                }
                : {})
        },
        meta: {
            v: 1
        }
    }
}
