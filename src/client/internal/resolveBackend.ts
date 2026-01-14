import { Protocol } from '#protocol'
import { Backend } from '#backend'
import type { BackendConfig, BackendEndpointConfig, HttpSyncBackendConfig, MemoryBackendConfig, IndexedDBBackendConfig, ResolvedBackend, ResolvedBackends, StoreBackendEndpointConfig } from '../types/backend'

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

function resolveHttpBackend(args: { http: HttpSyncBackendConfig }): ResolvedBackend {
    const http = args.http
    const baseURL = String(http.baseURL || '')
    if (!baseURL) {
        throw new Error('[Atoma] backend.http.baseURL is required')
    }

    const key = String(baseURL)

    const opsClient = new Backend.Ops.HttpOpsClient({
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

    const hasSubscribe = Boolean(http.subscribeUrl || http.subscribePath || http.eventSourceFactory)
    const subscribeBaseUrl = http.subscribeUrl
        ? http.subscribeUrl
        : (args2?: { resources?: string[] }) => {
            const path = http.subscribePath ?? Protocol.http.paths.SYNC_SUBSCRIBE
            return withResourcesParam(joinUrl(baseURL, path), args2?.resources)
        }

    return {
        key,
        opsClient,
        ...(hasSubscribe
            ? {
                sse: {
                    buildUrl: subscribeBaseUrl,
                    eventSourceFactory: http.eventSourceFactory
                }
            }
            : {})
    }
}

function resolveMemoryBackend(args: { memory: MemoryBackendConfig }): ResolvedBackend {
    const key = 'memory'
    return {
        key,
        opsClient: new Backend.Ops.MemoryOpsClient(args.memory)
    }
}

function resolveIndexedDBBackend(args: { indexeddb: IndexedDBBackendConfig }): ResolvedBackend {
    const key = 'indexeddb'
    return {
        key,
        opsClient: new Backend.Ops.IndexedDBOpsClient(args.indexeddb)
    }
}

function isEndpointConfig(config: BackendConfig): config is StoreBackendEndpointConfig | BackendEndpointConfig {
    if (typeof config === 'string') return true
    if (!config || typeof config !== 'object' || Array.isArray(config)) return false
    if ('http' in config) return true
    if ('memory' in config) return true
    if ('indexeddb' in config) return true
    if ('opsClient' in config) return true
    return false
}

function resolveEndpoint(config: StoreBackendEndpointConfig | BackendEndpointConfig): ResolvedBackend {
    if (typeof config === 'string') {
        const baseURL = config
        return resolveHttpBackend({ http: { baseURL } })
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('[Atoma] backend is required')
    }

    if ('http' in config && (config as any).http) {
        return resolveHttpBackend({
            http: (config as any).http
        })
    }

    if ('memory' in config && (config as any).memory) {
        return resolveMemoryBackend({
            memory: (config as any).memory
        })
    }

    if ('indexeddb' in config && (config as any).indexeddb) {
        return resolveIndexedDBBackend({
            indexeddb: (config as any).indexeddb
        })
    }

    if ('opsClient' in config && (config as any).opsClient) {
        const id = String((config as any).id || '')
        if (!id) {
            throw new Error('[Atoma] backend.id is required when using a custom opsClient')
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
            key: id,
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
                store: resolved,
                local: resolved,
                sync: undefined
            }
        }
        if (isHttpLike) {
            return {
                key: resolved.key,
                store: resolved,
                remote: resolved,
                sync: resolved
            }
        }
        return {
            key: resolved.key,
            store: resolved,
            sync: resolved,
            remote: resolved
        }
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('[Atoma] backend is required')
    }

    const local = config.local ? resolveEndpoint(config.local) : undefined
    const remote = config.remote ? resolveEndpoint(config.remote) : undefined

    const store = local ?? remote
    if (!store) {
        throw new Error('[Atoma] backend.local or backend.remote is required')
    }

    return {
        key: remote?.key ?? store.key,
        local,
        remote,
        store,
        sync: remote
    }
}
