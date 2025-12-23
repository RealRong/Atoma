import type { FindManyOptions, PageInfo, StoreKey } from '../../../core/types'
import type { DevtoolsBridge } from '../../../devtools/types'
import type { ObservabilityContext } from '#observability'
import type { Envelope } from '#protocol'

export type RetryConfig = import('../transport/retry').RetryConfig

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
    reconnectDelayMs?: number
    periodicPullIntervalMs?: number
    pullLimit?: number
    cursorKey?: string
    deviceIdKey?: string
    autoStart?: boolean
    maxQueueSize?: number
    inFlightTimeoutMs?: number
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    sse?: SyncSseConfig
    retry?: { maxAttempts?: number }
    backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
    lockKey?: string
    lockTtlMs?: number
    lockRenewIntervalMs?: number
}

export interface QueryConfig<T> {
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
) => Promise<Envelope<T>> | Envelope<T>

export interface BatchQueryConfig {
    enabled?: boolean
    endpoint?: string
    maxBatchSize?: number
    flushIntervalMs?: number
    devWarnings?: boolean
}

export interface HTTPAdapterConfig<T> {
    baseURL: string
    resourceName: string
    headers?: () => Promise<Record<string, string>> | Record<string, string>
    retry?: RetryConfig
    sync?: SyncConfig
    query?: QueryConfig<T>
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
        envelope: Envelope<T>
        request: Request
    }) => void
}
