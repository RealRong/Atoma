import { Protocol } from '#protocol'
import { Backend } from '#backend'
import type {
    BackendConfig,
    HttpBackendConfig,
    MemoryBackendConfig,
    IndexedDBBackendConfig,
    ResolvedBackend,
    ResolvedBackends,
    StoreBackendEndpointConfig,
    BackendEndpointConfig
} from '#client/types/backend'
import { Shared } from '#shared'
import { BackendSchemas } from '#client/schemas'

const { parseOrThrow } = Shared.zod

type HttpConfig = HttpBackendConfig & {
    subscribe?: {
        buildUrl?: (args?: { resources?: string[] }) => string
        connect?: (url: string) => EventSource
    }
}

type ResolvedEndpoint =
    | { type: 'http'; http: HttpConfig }
    | { type: 'memory'; memory: MemoryBackendConfig }
    | { type: 'indexeddb'; indexeddb: IndexedDBBackendConfig }
    | { type: 'customOps'; id: string; opsClient: any; subscribe?: any; sse?: { buildUrl: (args?: { resources?: string[] }) => string; connect?: (url: string) => EventSource } }

function resolveHttpBackend(http: HttpConfig): ResolvedBackend {
    const baseURL = String(http.baseURL)

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

    const subscribeCfg = http.subscribe
    const hasSubscribe = Boolean(subscribeCfg)
    const buildUrl = subscribeCfg?.buildUrl
        ? subscribeCfg.buildUrl
        : (args2?: { resources?: string[] }) => Shared.url.withResourcesParam(
            Shared.url.resolveUrl(baseURL, Protocol.http.paths.SYNC_SUBSCRIBE),
            args2?.resources
        )

    return {
        key,
        opsClient,
        ...(hasSubscribe
            ? {
                sse: {
                    buildUrl,
                    connect: subscribeCfg?.connect
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

function resolveEndpoint(endpoint: ResolvedEndpoint): ResolvedBackend {
    switch (endpoint.type) {
        case 'http':
            return resolveHttpBackend(endpoint.http)

        case 'memory':
            return resolveMemoryBackend({ memory: endpoint.memory })

        case 'indexeddb':
            return resolveIndexedDBBackend({ indexeddb: endpoint.indexeddb })

        case 'customOps': {
            const id = String(endpoint.id)
            return {
                key: id,
                opsClient: endpoint.opsClient,
                ...(endpoint.subscribe ? { subscribe: endpoint.subscribe } : {}),
                ...(endpoint.sse
                    ? {
                        sse: {
                            buildUrl: endpoint.sse.buildUrl,
                            connect: endpoint.sse.connect
                        }
                    }
                    : {})
            }
        }

        default: {
            const _exhaustive: never = endpoint
            throw new Error(`[Atoma] Invalid backend endpoint: ${String((_exhaustive as any)?.type)}`)
        }
    }
}

const resolveBackendSchema = BackendSchemas.backendResolutionConfigSchema.transform((parsed: any): ResolvedBackends => {
    switch (parsed.kind as 'single' | 'pair') {
        case 'pair': {
            const local = parsed.local ? resolveEndpoint(parsed.local as ResolvedEndpoint) : undefined
            const remote = parsed.remote ? resolveEndpoint(parsed.remote as ResolvedEndpoint) : undefined
            const store = local ?? remote!
            return { key: remote?.key ?? store.key, local, remote, store }
        }

        case 'single': {
            const endpoint = parsed.endpoint as ResolvedEndpoint
            const resolved = resolveEndpoint(endpoint)

            const isLocalOnly = endpoint.type === 'memory' || endpoint.type === 'indexeddb'
            if (isLocalOnly) return { key: resolved.key, store: resolved, local: resolved }
            return { key: resolved.key, store: resolved, remote: resolved }
        }

        default: {
            throw new Error(`[Atoma] Invalid backend config kind: ${String(parsed.kind)}`)
        }
    }
})

export function resolveBackend(config: BackendConfig): ResolvedBackends {
    return parseOrThrow(resolveBackendSchema, config, { prefix: '[Atoma] backend: ' }) as any
}
