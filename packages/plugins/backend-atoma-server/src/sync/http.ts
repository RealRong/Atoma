import { isRecord, requestJson } from '@atoma-js/shared'
import type { Envelope, RemoteOpsResponseData } from '@atoma-js/types/protocol'
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
    const { request, response, payload } = await requestJson({
        baseURL: args.baseURL,
        path: args.path,
        fetchFn: args.fetchFn,
        headers: args.headers,
        retry: args.retry,
        onRequest: args.onRequest,
        method: 'POST',
        body: args.request,
        defaultContentType: 'application/json; charset=utf-8',
        jsonMode: 'strict',
        emptyJsonValue: {},
        invalidJsonMessage: '[Sync] response body is not valid JSON'
    })

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
