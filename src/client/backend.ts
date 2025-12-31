import { Protocol, type Envelope, type OpsResponseData } from '#protocol'
import { Backend, type OpsClient, type RetryOptions } from '#backend'
import type { SyncTransport } from '#sync'
import type { Table } from 'dexie'
import type { StoreKey } from '#core'

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

export type MemoryBackendConfig = {
    seed?: Record<string, any[]>
}

export type IndexedDBBackendConfig = {
    tableForResource: (resource: string) => Table<any, StoreKey>
    transformData?: (args: { resource: string; data: any }) => any | undefined
}

export type BackendEndpointConfig =
    | string
    | { key?: string; http: HttpBackendConfig }
    | { key?: string; memory: MemoryBackendConfig }
    | { key?: string; indexeddb: IndexedDBBackendConfig }
    | {
        key: string
        opsClient: OpsClient
        subscribe?: SyncTransport['subscribe']
        sse?: {
            subscribeUrl: (args?: { resources?: string[] }) => string
            eventSourceFactory?: (url: string) => EventSource
        }
    }

export type BackendConfig =
    | BackendEndpointConfig
    | {
        /**
         * Local-first: local handles reads/writes for IDataSource (OpsDataSource).
         * Remote handles sync transport (push/pull/subscribe).
         */
        local?: BackendEndpointConfig
        remote?: BackendEndpointConfig
    }

export type ResolvedBackend = {
    key: string
    opsClient: OpsClient
    subscribe?: SyncTransport['subscribe']
    sse?: {
        buildUrl: (args?: { resources?: string[] }) => string
        eventSourceFactory?: (url: string) => EventSource
    }
}

export type ResolvedBackends = {
    /**
     * A stable identifier for this client instance.
     * - When remote exists, uses remote.key (sync identity).
     * - Otherwise falls back to dataSource.key.
     */
    key: string
    /** Optional local backend (for local-first). */
    local?: ResolvedBackend
    /** Optional remote backend (for sync/transport). */
    remote?: ResolvedBackend
    /** Backend used by default OpsDataSource instances. */
    dataSource: ResolvedBackend
    /** Backend used by SyncController (usually remote). */
    sync?: ResolvedBackend
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

    const opsClient = new Backend.HttpOpsClient({
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

function resolveMemoryBackend(args: { key?: string; memory: MemoryBackendConfig }): ResolvedBackend {
    const key = String(args.key ?? 'memory')
    return {
        key,
        opsClient: new Backend.MemoryOpsClient(args.memory)
    }
}

function resolveIndexedDBBackend(args: { key?: string; indexeddb: IndexedDBBackendConfig }): ResolvedBackend {
    const key = String(args.key ?? 'indexeddb')
    return {
        key,
        opsClient: new Backend.IndexedDBOpsClient(args.indexeddb)
    }
}

function isEndpointConfig(config: BackendConfig): config is BackendEndpointConfig {
    if (typeof config === 'string') return true
    if (!config || typeof config !== 'object' || Array.isArray(config)) return false
    if ('http' in config) return true
    if ('memory' in config) return true
    if ('indexeddb' in config) return true
    if ('opsClient' in config) return true
    return false
}

function resolveEndpoint(config: BackendEndpointConfig): ResolvedBackend {
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

    if ('memory' in config && (config as any).memory) {
        return resolveMemoryBackend({
            key: (config as any).key,
            memory: (config as any).memory
        })
    }

    if ('indexeddb' in config && (config as any).indexeddb) {
        return resolveIndexedDBBackend({
            key: (config as any).key,
            indexeddb: (config as any).indexeddb
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

export function resolveBackend(config: BackendConfig): ResolvedBackends {
    if (isEndpointConfig(config)) {
        const resolved = resolveEndpoint(config)
        const isHttpLike = typeof config === 'string' || ('http' in (config as any) && (config as any).http)
        const isLocalOnly = ('memory' in (config as any) && (config as any).memory) || ('indexeddb' in (config as any) && (config as any).indexeddb)
        if (isLocalOnly) {
            return {
                key: resolved.key,
                dataSource: resolved,
                local: resolved,
                sync: undefined
            }
        }
        if (isHttpLike) {
            return {
                key: resolved.key,
                dataSource: resolved,
                remote: resolved,
                sync: resolved
            }
        }
        return {
            key: resolved.key,
            dataSource: resolved,
            sync: resolved,
            remote: resolved
        }
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('[Atoma] backend is required')
    }

    const local = config.local ? resolveEndpoint(config.local) : undefined
    const remote = config.remote ? resolveEndpoint(config.remote) : undefined

    const dataSource = local ?? remote
    if (!dataSource) {
        throw new Error('[Atoma] backend.local or backend.remote is required')
    }

    return {
        key: remote?.key ?? dataSource.key,
        local,
        remote,
        dataSource,
        sync: remote
    }
}
