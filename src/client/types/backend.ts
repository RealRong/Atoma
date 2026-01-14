import type { OpsClient, RetryOptions } from '#backend'
import type { Envelope, OpsResponseData } from '#protocol'
import type { SyncSubscribe } from '#sync'
import type { Table } from 'dexie'

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
    subscribePath?: string
    subscribeUrl?: (args?: { resources?: string[] }) => string
    eventSourceFactory?: (url: string) => EventSource
}

export type HttpSyncBackendConfig = HttpBackendConfig & HttpSubscribeConfig

export type MemoryBackendConfig = {
    seed?: Record<string, any[]>
}

export type IndexedDBBackendConfig = {
    tableForResource: (resource: string) => Table<any, string>
    transformData?: (args: { resource: string; data: any }) => any | undefined
}

export type StoreCustomOpsBackendConfig = {
    id: string
    opsClient: OpsClient
}

export type CustomOpsBackendConfig = StoreCustomOpsBackendConfig & {
    subscribe?: SyncSubscribe
    sse?: {
        subscribeUrl: (args?: { resources?: string[] }) => string
        eventSourceFactory?: (url: string) => EventSource
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
         * - remote：处理 sync transport（push/pull/subscribe）
         */
        local?: StoreBackendEndpointConfig
        remote?: BackendEndpointConfig
    }

export type ResolvedBackend = {
    key: string
    opsClient: OpsClient
    subscribe?: SyncSubscribe
    sse?: {
        buildUrl: (args?: { resources?: string[] }) => string
        eventSourceFactory?: (url: string) => EventSource
    }
}

export type ResolvedBackends = {
    /**
     * A stable identifier for this client instance.
     * - When remote exists, uses remote.key (sync identity).
     * - Otherwise falls back to store.key.
     */
    key: string
    /** Optional local backend (for local-first). */
    local?: ResolvedBackend
    /** Optional remote backend (for sync/transport). */
    remote?: ResolvedBackend
    /** Backend used by Store (读写). */
    store: ResolvedBackend
    /** Backend used by SyncController (usually remote). */
    sync?: ResolvedBackend
}
