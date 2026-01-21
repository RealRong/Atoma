import type { Cursor } from '#protocol'
import type {
    SyncBackoffConfig,
    SyncEvent,
    SyncOutboxEvents,
    SyncPhase,
    SyncRetryConfig
} from 'atoma-sync'
import type { AtomaSyncStartMode } from './client'
import type { HttpEndpointOptions } from './options'

export type SyncMode = AtomaSyncStartMode
export type OutboxMode = 'queue' | 'local-first'

export type SyncEndpointConfig = Readonly<{
    url: string
    http?: HttpEndpointOptions
    sse?: string
}>

export type SyncEngineConfig = Readonly<{
    mode: SyncMode
    resources?: string[]
    initialCursor?: Cursor

    pull: Readonly<{
        limit: number
        debounceMs: number
        intervalMs: number
    }>

    push: Readonly<{
        maxItems: number
        returning: boolean
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    }>

    subscribe: Readonly<{
        enabled: boolean
        eventName?: string
        reconnectDelayMs: number
    }>

    retry: SyncRetryConfig
    backoff: SyncBackoffConfig
    now?: () => number

    onError?: (error: Error, context: { phase: SyncPhase }) => void
    onEvent?: (event: SyncEvent) => void
}>

export type SyncOutboxConfig = false | Readonly<{
    mode: OutboxMode
    storage: Readonly<{
        maxSize: number
        inFlightTimeoutMs: number
    }>
    events?: SyncOutboxEvents
}>

export type SyncStateConfig = Readonly<{
    deviceId: string
    keys: Readonly<{
        outbox: string
        cursor: string
        lock: string
    }>
    lock: Readonly<{
        ttlMs?: number
        renewIntervalMs?: number
    }>
}>

/**
 * 最终内部模型（Normalized）：
 * - endpoint/engine/outbox/state 的结构与默认值都已归一化
 * - 不再存在 queue/maxQueueSize/outboxEvents/advanced 等旧字段
 */
export type AtomaClientSyncConfig = Readonly<{
    endpoint: SyncEndpointConfig
    engine: SyncEngineConfig
    outbox: SyncOutboxConfig
    state: SyncStateConfig
}>
