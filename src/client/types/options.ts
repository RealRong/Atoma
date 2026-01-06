import type { Entity, StoreKey } from '#core'
import type { Table } from 'dexie'
import type { AtomaSchema } from './schema'
import type { BackendEndpointConfig, HttpBackendConfig, StoreBackendEndpointConfig } from './backend'
import type { SyncQueueWriteMode } from './sync'

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
    /** Enable/disable batching for the default `OpsDataSource` created per store. */
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
    tables: Record<string, Table<any, StoreKey>>
}

export interface HttpTargetConfig extends HttpEndpointOptions {
    /** Base URL of the target server that serves the ops endpoint. */
    url: string
}

export type LocalServerConfig = HttpTargetConfig

export interface HttpStoreConfig extends HttpTargetConfig {
    /** Direct CRUD hits a remote HTTP backend (online-first). */
    type: 'http'
}

export interface IndexedDbStoreConfig {
    /** Direct CRUD hits IndexedDB (durable local-first). */
    type: 'indexeddb'
    /** Dexie tables used as local storage. */
    tables: IndexedDbTablesConfig['tables']
}

export interface LocalServerStoreConfig extends HttpTargetConfig {
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

export type SyncEventHandler = (event: unknown) => void
export type SyncErrorHandler = (error: Error, context: unknown) => void

export interface SyncQueueEvents {
    /** Maximum number of queued items allowed in outbox. */
    maxQueueSize?: number
    /** Called whenever the queue size changes. */
    onQueueChange?: (size: number) => void
    /** Called when the queue is full and an item is dropped. */
    onQueueFull?: (args: { maxSize: number; droppedOp: unknown }) => void
}

export interface SyncAdvancedOptions {
    /**
     * Advanced persistence keys. Usually you should NOT set these.
     * - For most apps, prefer `sync.deviceId` and let keys be derived automatically.
     * - These exist mainly for deterministic tests and migrations.
     */
    outboxKey?: string
    cursorKey?: string
    lockKey?: string
    lockTtlMs?: number
    lockRenewIntervalMs?: number
}

export interface SyncTransportOptions {
    /**
     * SSE subscribe path (relative to `sync.url`) used by `Sync.start('subscribe-only' | 'pull+subscribe' | 'full')`.
     * When omitted, those modes require a custom `sync.backend` with subscribe capability.
     */
    sse?: string
}

export interface SyncDefaultsInput<ResourceName extends string = string> {
    /**
     * Device identity used to derive internal persistence keys (outbox/cursor/lock).
     * - Provide a stable ID to treat multiple tabs/windows as the same "device".
     * - Provide a per-tab ID to treat each tab as an independent "device".
     */
    deviceId?: string
    /**
     * Resources to replicate.
     * - For best DX, this is typed to your store names (e.g. `keyof Entities`).
     * - When omitted, server decides (or client defaults may derive it).
     */
    resources?: ResourceName[]
    /** Whether to request server writeback payloads on write operations (when supported). */
    returning?: boolean
    /** Enable/disable subscribe (SSE) when the chosen start mode wants it. */
    subscribe?: boolean
    /**
     * SSE event name for subscribe notifications.
     * Defaults to the protocol event name on the server.
     */
    subscribeEventName?: string
    /** Pull limit per request (max number of changes). */
    pullLimit?: number
    /** Debounce window for pull scheduling. */
    pullDebounceMs?: number
    /** Periodic pull interval. `0` typically disables periodic pulls. */
    pullIntervalMs?: number
    /** Reconnect delay for SSE subscribe. */
    reconnectDelayMs?: number
    /** Timeout for an in-flight push batch (ms). */
    inFlightTimeoutMs?: number
    /**
     * Retry policy for sync network requests.
     * Note: The sync engine currently mainly uses `maxAttempts`; other fields may be ignored by some lanes.
     */
    retry?: HttpBackendConfig['retry']
    /** Backoff policy shared by pull/push/subscribe. */
    backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
    /** Custom clock source (advanced). */
    now?: () => number
    /** Conflict strategy for push rejections. */
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    /** Sync event callback (observability/telemetry). */
    onEvent?: SyncEventHandler
    /** Sync error callback (observability/telemetry). */
    onError?: SyncErrorHandler
}

export type SyncQueueInput = false | true | SyncQueueWriteMode

export interface CreateHttpClientSyncOptions<ResourceName extends string = string>
    extends SyncDefaultsInput<ResourceName>, SyncTransportOptions, SyncQueueEvents {
    /** Advanced persistence overrides (rare). */
    advanced?: SyncAdvancedOptions
    /** Enable queued writes for `client.Sync.Store(name)` (rare for pure http clients). */
    queue?: SyncQueueInput
}

export type CreateHttpClientOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = {
    /** Domain schema (indexes/relations/validators/etc). */
    schema?: Schema
    /** Base URL of the remote server used for direct CRUD. */
    url: string
} & HttpEndpointOptions & {
    /** Convenience SSE subscribe path for sync (relative to `url`). */
    sse?: string
    /** Replication defaults for this client (pull/subscribe behavior). */
    sync?: string | CreateHttpClientSyncOptions<keyof Entities & string>
}

export interface LocalFirstStorageIndexedDb {
    /** Local durable storage backed by IndexedDB (Dexie). */
    type: 'indexeddb'
    /** Dexie tables used as local storage. */
    tables: IndexedDbTablesConfig['tables']
}

export interface LocalFirstStorageLocalServer extends HttpTargetConfig {
    /** Local durable storage backed by a local server (HTTP). */
    type: 'localServer'
}

export interface CreateLocalFirstClientSyncOptions<ResourceName extends string = string>
    extends HttpTargetConfig, SyncDefaultsInput<ResourceName>, SyncTransportOptions, SyncQueueEvents {
    /** Advanced persistence overrides (rare). */
    advanced?: SyncAdvancedOptions
    /** Queued write strategy for `client.Sync.Store(name)`. */
    queue?: SyncQueueInput
}

export type CreateLocalFirstClientOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = {
    /** Domain schema (indexes/relations/validators/etc). */
    schema?: Schema
    /** Local durable storage used for direct CRUD. */
    storage:
        | LocalFirstStorageIndexedDb
        | LocalFirstStorageLocalServer
    /**
     * Sync target used by the Replicator (remote cloud endpoint).
     * - If string: treated as `url`
     * - If object: allows passing HTTP overrides and sync defaults
     */
    sync:
        | string
        | CreateLocalFirstClientSyncOptions<keyof Entities & string>
}

export interface CreateClientSyncOptions<ResourceName extends string = string>
    extends Partial<HttpTargetConfig>, SyncDefaultsInput<ResourceName>, SyncTransportOptions, SyncQueueEvents {
    /** Advanced persistence overrides (rare). */
    advanced?: SyncAdvancedOptions
    /**
     * Explicit backend endpoint config (advanced).
     * - When provided, `sync.url`/HTTP override fields are ignored for target selection.
     */
    backend?: BackendEndpointConfig
    /**
     * Enable queued writes for `client.Sync.Store(name)`.
     * - `false` disables, even if `outboxKey/onQueueChange/...` are present.
     * - `true` enables with defaults derived from the store backend role.
     * - `'intent-only' | 'local-first'` enables and selects the queued write strategy.
     */
    queue?: SyncQueueInput
}

export type CreateClientOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = {
    /** Domain schema (indexes/relations/validators/etc). */
    schema?: Schema
    /** Store backend used for direct CRUD (`client.Store(name)`). */
    store: StoreConfig
    /** Default batching config for the generated data sources. */
    storeBatch?: StoreBatchOptions
    /**
     * Sync/Replication config (optional).
     * - `url`/`backend`: remote target. When omitted, it may be derived from `store` when `store` is remote.
     * - `queue`: enables queued writes for `client.Sync.Store(name)`; can be `true` or `'intent-only' | 'local-first'`.
     * - outbox/cursor/lock keys live under `sync.advanced`.
     */
    sync?: string | CreateClientSyncOptions<keyof Entities & string>
}
