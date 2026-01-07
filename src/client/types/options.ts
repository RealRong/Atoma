import type { Entity, StoreKey } from '#core'
import type { Table } from 'dexie'
import type { AtomaSchema } from './schema'
import type { BackendEndpointConfig, HttpBackendConfig, StoreBackendEndpointConfig } from './backend'
import type { AtomaSyncStartMode } from './client'

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
     * Default sync start mode used when calling `Sync.start()` without explicit mode.
     * When omitted, mode is derived from `queue` + subscribe capability.
     */
    mode?: AtomaSyncStartMode
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

export type SyncQueueInput = false | 'queue' | 'local-first'

export interface CreateClientSyncOptions<ResourceName extends string = string>
    extends SyncDefaultsInput<ResourceName>, SyncTransportOptions, SyncQueueEvents {
    /** Base URL of the sync target server (shortcut for HTTP backend). */
    url?: string
    /**
     * Optional per-lane HTTP overrides for sync transport.
     * When omitted, falls back to top-level `http` defaults on `createClient`.
     */
    http?: HttpEndpointOptions
    /** Advanced persistence overrides (rare). */
    advanced?: SyncAdvancedOptions
    /**
     * Explicit backend endpoint config (advanced).
     * When provided, `url/http/sse` are ignored for target selection.
     */
    backend?: BackendEndpointConfig
    /**
     * Queued write strategy for `client.Sync.Store(name)`.
     * - `false` disables queued writes.
     * - `'queue'` queues intents only (no local durable write).
     * - `'local-first'` writes to local durable store first, then enqueues.
     */
    queue?: SyncQueueInput
}

export type CreateClientOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = {
    /** Domain schema (indexes/relations/validators/etc). */
    schema?: Schema
    /**
     * Shared HTTP defaults applied to both Store and Sync lanes.
     * Use `store.http` / `sync.http` to override per lane.
     */
    http?: HttpEndpointOptions
    /** Store backend used for direct CRUD (`client.Store(name)`). */
    store: StoreConfig
    /** Default batching config for the generated data sources. */
    storeBatch?: StoreBatchOptions
    /**
     * Sync/Replication config (optional).
     * - `url`/`backend`: remote target. When omitted, it may be derived from `store` when `store` is remote.
     * - `queue`: enables queued writes for `client.Sync.Store(name)`; can be `'queue' | 'local-first'`.
     * - outbox/cursor/lock keys live under `sync.advanced`.
     */
    sync?: string | CreateClientSyncOptions<keyof Entities & string>
}
