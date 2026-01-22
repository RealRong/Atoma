import type { Entity, StoreDataProcessor } from '#core'
import type { Table } from 'dexie'
import type { AtomaSchema } from './schema'
import type { HttpBackendConfig, StoreBackendEndpointConfig } from './backend'
import type { Cursor } from '#protocol'
import type { SyncBackoffConfig, SyncEvent, SyncOutboxEvents, SyncPhase, SyncRetryConfig } from 'atoma-sync'

/**
 * Extra HTTP backend options shared by both Store (direct) and Sync (replication) endpoints.
 * - `baseURL` is always provided by the high-level `url` fields, so it is omitted here.
 */
export interface HttpEndpointOptions {
    /**
     * Override the ops endpoint path (defaults to the protocol constant).
     * Example: `/ops`
     */
    opsPath?: HttpBackendConfig['opsPath']

    /**
     * Static or async request headers, evaluated per request.
     * Useful for auth tokens.
     */
    headers?: HttpBackendConfig['headers']

    /**
     * Retry policy for HTTP requests.
     * Applies to both direct CRUD (store) and sync transport (replicator).
     */
    retry?: HttpBackendConfig['retry']

    /**
     * Custom `fetch` implementation (e.g. to inject auth, mock, or block in offline mode).
     */
    fetchFn?: HttpBackendConfig['fetchFn']

    /**
     * Request interceptor, called before sending the request.
     * You may return a new Request or mutate via cloning.
     */
    onRequest?: HttpBackendConfig['onRequest']

    /**
     * Response interceptor, called after parsing the protocol envelope.
     */
    onResponse?: HttpBackendConfig['onResponse']

    /**
     * Custom envelope parser for non-standard server responses.
     */
    responseParser?: HttpBackendConfig['responseParser']
}

export type StoreBatchOptions =
    | boolean
    | StoreBatchConfig

export interface StoreBatchConfig {
    /** Enable/disable batching for the default HTTP ops client (per-store 写入合批). */
    enabled?: boolean
    /** Maximum number of operations per batch request. */
    maxBatchSize?: number
    /** Flush interval for pending batched operations. */
    flushIntervalMs?: number
    /** Emit dev warnings when batching heuristics detect suspicious usage. */
    devWarnings?: boolean
}

export interface IndexedDbTablesConfig {
    /** Map of `resourceName -> Dexie Table` */
    tables: Record<string, Table<any, string>>
}

export interface HttpLaneConfig {
    /** Base URL of the target server that serves the ops endpoint. */
    url: string
    /**
     * Optional per-lane HTTP overrides.
     * When omitted, falls back to top-level `http` defaults on `createClient`.
     */
    http?: HttpEndpointOptions
}

export interface HttpStoreConfig extends HttpLaneConfig {
    /** Direct CRUD hits a remote HTTP backend (online-first). */
    type: 'http'
}

export interface IndexedDbStoreConfig {
    /** Direct CRUD hits IndexedDB (durable local-first). */
    type: 'indexeddb'
    /** Dexie tables used as local storage. */
    tables: IndexedDbTablesConfig['tables']
}

export interface LocalServerStoreConfig extends HttpLaneConfig {
    /** Direct CRUD hits a local server (e.g. node/go on localhost). */
    type: 'localServer'
}

export interface MemoryStoreConfig {
    /** In-memory store only (tests/demos). */
    type: 'memory'
    /** Optional initial data to seed memory stores. */
    seed?: Record<string, any[]>
}

export interface CustomStoreConfig {
    /** Fully custom backend endpoint (advanced). */
    type: 'custom'
    /** Whether this backend behaves as local-durable or remote-online. */
    role: 'local' | 'remote'
    /** Custom backend endpoint config used to build the ops client. */
    backend: StoreBackendEndpointConfig
}

export type StoreConfig =
    | HttpStoreConfig
    | IndexedDbStoreConfig
    | LocalServerStoreConfig
    | MemoryStoreConfig
    | CustomStoreConfig

export type SyncMode = 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full'
export type OutboxMode = 'queue' | 'local-first'

export type EndpointConfigInput =
    | string
    | {
        url: string
        http?: HttpEndpointOptions
        sse?: string
    }

export type EngineConfigInput<ResourceName extends string = string> =
    | SyncMode
    | {
        mode?: SyncMode
        resources?: ResourceName[]
        initialCursor?: Cursor
        pull?: { limit?: number; debounceMs?: number; intervalMs?: number }
        push?: { maxItems?: number; returning?: boolean; conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual' }
        subscribe?: { enabled?: boolean; eventName?: string; reconnectDelayMs?: number }
        retry?: SyncRetryConfig
        backoff?: SyncBackoffConfig
        now?: () => number
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: SyncEvent) => void
    }

export type OutboxConfigInput =
    | false
    | OutboxMode
    | {
        mode?: OutboxMode
        storage?: { maxSize?: number; inFlightTimeoutMs?: number }
        events?: SyncOutboxEvents
    }

export type SyncStateConfigInput = {
    deviceId?: string
    keys?: { outbox?: string; cursor?: string; lock?: string }
    lock?: { ttlMs?: number; renewIntervalMs?: number }
}

/**
 * 对外输入模型（Input）：允许简写，但会在内部归一化为 AtomaClientSyncConfig（Normalized）。
 */
export type SyncConfigInput<ResourceName extends string = string> = {
    url?: string
    sse?: string
    mode?: SyncMode
    outbox?: OutboxConfigInput
    endpoint?: EndpointConfigInput
    engine?: EngineConfigInput<ResourceName>
    state?: SyncStateConfigInput
}

export type CreateClientOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = {
    /** Domain schema (indexes/relations/validators/etc). */
    schema?: Schema
    /** Global dataProcessor applied to all stores (per-store config overrides). */
    dataProcessor?: StoreDataProcessor<any>
    /**
     * Shared HTTP defaults applied to both Store and Sync lanes.
     * Use `store.http` / `sync.endpoint.http` to override per lane.
     */
    http?: HttpEndpointOptions
    /** Store backend used for direct CRUD (`client.Store(name)`). */
    store: StoreConfig
    /** Default batching config for the generated data sources. */
    storeBatch?: StoreBatchOptions
    /**
     * Sync/Replication config (optional).
     * 本模型已明确只支持 HTTP endpoint（无 custom/backend），并在内部归一化为 AtomaClientSyncConfig（Normalized）。
     */
    sync?: SyncConfigInput<keyof Entities & string>
}
