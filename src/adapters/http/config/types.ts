import type { Patch } from 'immer'
import type { FindManyOptions, PageInfo, PatchMetadata, StoreKey } from '../../../core/types'
import type { DevtoolsBridge } from '../../../devtools/types'
import type { ObservabilityContext } from '#observability'
import type { StandardEnvelope } from '#protocol'
import type { QuerySerializerConfig } from '../query'

export type RetryConfig = import('../transport/retry').RetryConfig

export interface ConflictConfig<T> {
    resolution?: 'last-write-wins' | 'server-wins' | 'manual'
    onConflict?: (args: {
        key: StoreKey
        local: T | Patch[]
        server: any
        metadata?: PatchMetadata
    }) => Promise<'accept-server' | 'retry-local' | 'ignore'> | 'accept-server' | 'retry-local' | 'ignore'
}

export interface VersionConfig {
    field?: string
    header?: string
    cacheSize?: number
}

export interface OfflineConfig {
    enabled?: boolean
    maxQueueSize?: number
    syncOnReconnect?: boolean
}

export interface SyncEndpointsConfig {
    push?: string
    pull?: string
    subscribe?: string
    ops?: string
    subscribeVNext?: string
}

export interface SyncSseConfig {
    buildSubscribeUrl?: (args: { url: string; cursor: number; headers: Record<string, string> }) => string | Promise<string>
    eventSourceFactory?: (url: string) => EventSource
}

export interface SyncConfig {
    enabled?: boolean
    mode?: 'sse' | 'poll'
    endpoints?: SyncEndpointsConfig
    pollIntervalMs?: number
    pullLimit?: number
    cursorKey?: string
    deviceIdKey?: string
    autoStart?: boolean
    sse?: SyncSseConfig
}

export interface QueryConfig<T> {
    strategy?: 'REST' | 'Django' | 'GraphQL' | 'passthrough'
    serializer?: (options: FindManyOptions<T>) => URLSearchParams | object
    customFn?: (options: FindManyOptions<T>) => Promise<{ data: T[]; pageInfo?: PageInfo }>
}

export interface ConcurrencyConfig {
    get?: number
    put?: number
    delete?: number
    bulk?: number
}

export interface BulkConfig {
    fallback?: 'parallel' | 'sequential' | 'error'
    batchSize?: number
}

export interface EventCallbacks {
    onSyncStart?: (pending: number) => void
    onSyncComplete?: (remaining: number) => void
    onSyncError?: (error: Error, op: any) => void
    onQueueChange?: (size: number) => void
    onConflictResolved?: (serverValue: any, key: StoreKey) => void
    onQueueFull?: (droppedOp: any, maxSize: number) => void
}

export type ResponseParser<T, Raw = unknown> = (
    response: Response,
    data: Raw
) => Promise<StandardEnvelope<T>> | StandardEnvelope<T>

export interface BatchQueryConfig {
    enabled?: boolean
    endpoint?: string
    maxBatchSize?: number
    flushIntervalMs?: number
    devWarnings?: boolean
}

export interface HTTPAdapterConfig<T> {
    baseURL: string
    resourceName?: string
    endpoints?: {
        getOne?: string | ((id: StoreKey) => string)
        getAll?: string | (() => string)
        create?: string | (() => string)
        update?: string | ((id: StoreKey) => string)
        delete?: string | ((id: StoreKey) => string)
        patch?: string | ((id: StoreKey) => string)
        bulkCreate?: string | (() => string)
        bulkUpdate?: string | (() => string)
        bulkDelete?: string | (() => string)
        bulkDeleteQueryParam?: {
            path: string | (() => string)
            param: string
            maxUrlLength?: number
        }
    }
    headers?: () => Promise<Record<string, string>> | Record<string, string>
    retry?: RetryConfig
    conflict?: ConflictConfig<T>
    version?: VersionConfig
    offline?: OfflineConfig
    sync?: SyncConfig
    query?: QueryConfig<T>
    querySerializer?: QuerySerializerConfig
    concurrency?: ConcurrencyConfig
    bulk?: BulkConfig
    events?: EventCallbacks
    devtools?: DevtoolsBridge
    batch?: boolean | BatchQueryConfig
    responseParser?: ResponseParser<T>
    usePatchForUpdate?: boolean
    onRequest?: (request: Request) => Promise<Request | void> | Request | void
    onResponse?: (context: {
        response: Response
        envelope: StandardEnvelope<T>
        request: Request
    }) => void
}

