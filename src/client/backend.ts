import { Protocol, type Envelope, type OpsResponseData } from '#protocol'
import type { OpsClient } from '../backend/OpsClient'
import { HttpOpsClient } from '../backend/http/HttpOpsClient'
import type { RetryOptions } from '../backend/http/transport/retryPolicy'
import type { SyncTransport } from '../sync'

export type HttpBackendConfig = {
    baseURL: string
    opsPath?: string
    subscribePath?: string
    subscribeUrl?: (args?: { resources?: string[] }) => string
    eventSourceFactory?: (url: string) => EventSource

    headers?: () => Promise<Record<string, string>> | Record<string, string>
    retry?: RetryOptions
    fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

    onRequest?: (request: Request) => Promise<Request | void> | Request | void
    onResponse?: (context: {
        response: Response
        envelope: Envelope<OpsResponseData>
        request: Request
    }) => void
    responseParser?: (response: Response, data: unknown) => Promise<Envelope<OpsResponseData>> | Envelope<OpsResponseData>
}

export type BackendConfig =
    | string
    | { key?: string; http: HttpBackendConfig }
    | { key: string; opsClient: OpsClient; subscribe?: SyncTransport['subscribe']; sse?: { subscribeUrl: (args?: { resources?: string[] }) => string; eventSourceFactory?: (url: string) => EventSource } }

export type ResolvedBackend = {
    key: string
    opsClient: OpsClient
    subscribe?: SyncTransport['subscribe']
    sse?: {
        buildUrl: (args?: { resources?: string[] }) => string
        eventSourceFactory?: (url: string) => EventSource
    }
}

function joinUrl(base: string, path: string): string {
    if (!base) return path
    if (!path) return base

    const hasTrailing = base.endsWith('/')
    const hasLeading = path.startsWith('/')

    if (hasTrailing && hasLeading) return `${base}${path.slice(1)}`
    if (!hasTrailing && !hasLeading) return `${base}/${path}`
    return `${base}${path}`
}

function withResourcesParam(url: string, resources?: string[]): string {
    if (!resources?.length) return url
    const encoded = encodeURIComponent(resources.join(','))
    if (url.includes('?')) return `${url}&resources=${encoded}`
    return `${url}?resources=${encoded}`
}

function resolveHttpBackend(args: { key?: string; http: HttpBackendConfig }): ResolvedBackend {
    const http = args.http
    const baseURL = String(http.baseURL || '')
    if (!baseURL) {
        throw new Error('[Atoma] backend.http.baseURL is required')
    }

    const key = String(args.key ?? baseURL)

    const opsClient = new HttpOpsClient({
        baseURL,
        opsPath: http.opsPath ?? Protocol.http.paths.OPS,
        headers: http.headers,
        retry: http.retry,
        fetchFn: http.fetchFn,
        interceptors: {
            onRequest: http.onRequest,
            onResponse: http.onResponse,
            responseParser: http.responseParser
        }
    })

    const subscribeBaseUrl = http.subscribeUrl
        ? http.subscribeUrl
        : (args?: { resources?: string[] }) => {
            const path = http.subscribePath ?? Protocol.http.paths.SYNC_SUBSCRIBE
            return withResourcesParam(joinUrl(baseURL, path), args?.resources)
        }

    return {
        key,
        opsClient,
        sse: {
            buildUrl: subscribeBaseUrl,
            eventSourceFactory: http.eventSourceFactory
        }
    }
}

export function resolveBackend(config: BackendConfig): ResolvedBackend {
    if (typeof config === 'string') {
        const baseURL = config
        return resolveHttpBackend({ http: { baseURL } })
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('[Atoma] backend is required')
    }

    if ('http' in config && (config as any).http) {
        return resolveHttpBackend({
            key: (config as any).key,
            http: (config as any).http
        })
    }

    if ('opsClient' in config && (config as any).opsClient) {
        const key = String((config as any).key || '')
        if (!key) {
            throw new Error('[Atoma] backend.key is required when using a custom opsClient')
        }

        const sse = (config as any).sse
        const sseResolved = (sse && typeof sse === 'object' && !Array.isArray(sse) && typeof sse.subscribeUrl === 'function')
            ? {
                buildUrl: sse.subscribeUrl as (args?: { resources?: string[] }) => string,
                eventSourceFactory: typeof sse.eventSourceFactory === 'function'
                    ? (sse.eventSourceFactory as (url: string) => EventSource)
                    : undefined
            }
            : undefined

        return {
            key,
            opsClient: (config as any).opsClient,
            subscribe: typeof (config as any).subscribe === 'function' ? (config as any).subscribe : undefined,
            ...(sseResolved ? { sse: sseResolved } : {})
        }
    }

    throw new Error('[Atoma] Invalid backend config')
}
