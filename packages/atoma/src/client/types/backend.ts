import type { OpsClient, RetryOptions } from '#backend'
import type { Envelope, OpsResponseData } from '#protocol'
import type { Table } from 'dexie'

/**
 * Generic subscription hook used by backends (e.g. SSE notify).
 * - Kept protocol-agnostic on purpose; higher-level packages decide message shape.
 */
export type BackendSubscribe = (args: {
    resources?: string[]
    onMessage: (msg: unknown) => void
    onError: (error: unknown) => void
    signal?: AbortSignal
}) => { close: () => void }

export type HttpBackendConfig = {
    baseURL: string
    opsPath?: string

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

export type HttpSubscribeConfig = {
    subscribe?: {
        buildUrl?: (args?: { resources?: string[] }) => string
        connect?: (url: string) => EventSource
    }
}

export type HttpSyncBackendConfig = HttpBackendConfig & HttpSubscribeConfig

export type MemoryBackendConfig = {
    seed?: Record<string, any[]>
}

export type IndexedDBBackendConfig = {
    tableForResource: (resource: string) => Table<any, string>
}

export type StoreCustomOpsBackendConfig = {
    id: string
    opsClient: OpsClient
}

export type CustomOpsBackendConfig = StoreCustomOpsBackendConfig & {
    subscribe?: BackendSubscribe
    sse?: {
        buildUrl: (args?: { resources?: string[] }) => string
        connect?: (url: string) => EventSource
    }
}

export type StoreBackendEndpointConfig =
    | string
    | { http: HttpBackendConfig }
    | { memory: MemoryBackendConfig }
    | { indexeddb: IndexedDBBackendConfig }
    | StoreCustomOpsBackendConfig

export type BackendEndpointConfig =
    | string
    | { http: HttpSyncBackendConfig }
    | { memory: MemoryBackendConfig }
    | { indexeddb: IndexedDBBackendConfig }
    | CustomOpsBackendConfig

export type BackendConfig =
    | StoreBackendEndpointConfig
    | BackendEndpointConfig
    | {
        /**
         * Local-first:
         * - local：处理 Store 的读写（ops 协议）
         * - remote：可选的远端 endpoint（供扩展包使用）
         */
        local?: StoreBackendEndpointConfig
        remote?: BackendEndpointConfig
    }

export type ResolvedBackend = {
    key: string
    opsClient: OpsClient
    subscribe?: BackendSubscribe
    sse?: {
        buildUrl: (args?: { resources?: string[] }) => string
        connect?: (url: string) => EventSource
    }
}

export type ResolvedBackends = {
    /**
     * A stable identifier for this client instance.
     * - When remote exists, uses remote.key.
     * - Otherwise falls back to store.key.
     */
    key: string
    /** Optional local backend (for local-first). */
    local?: ResolvedBackend
    /** Optional remote backend (for extension packages). */
    remote?: ResolvedBackend
    /** Backend used by Store (读写). */
    store: ResolvedBackend
}
