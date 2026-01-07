import type { SyncEvent, SyncOutboxEvents, SyncPhase, SyncOutboxItem } from '#sync'
import type { HttpBackendConfig } from './backend'
import type { AtomaSyncStartMode } from './client'

export type SyncQueueWriteMode = 'intent-only' | 'local-first'

export type SyncQueueWritesArgs = {
    maxSize?: number
    onQueueChange?: (size: number) => void
    onQueueFull?: (args: { maxSize: number; droppedOp: SyncOutboxItem }) => void
}

export type SyncAdvancedArgs = {
    outboxKey?: string
    cursorKey?: string
    lockKey?: string
    lockTtlMs?: number
    lockRenewIntervalMs?: number
}

export type SyncDefaultsArgs = {
    mode?: AtomaSyncStartMode
    deviceId?: string
    advanced?: SyncAdvancedArgs
    resources?: string[]
    returning?: boolean
    subscribe?: boolean
    subscribeEventName?: string
    pullLimit?: number
    pullDebounceMs?: number
    periodicPullIntervalMs?: number
    reconnectDelayMs?: number
    inFlightTimeoutMs?: number
    retry?: HttpBackendConfig['retry']
    backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
    now?: () => number
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    onEvent?: (event: any) => void
    onError?: (error: Error, context: any) => void
}

export type AtomaClientSyncConfig = {
    /** Default mode used by `Sync.start()` when called without args. */
    mode?: AtomaSyncStartMode
    /** Device identity used to derive internal persistence keys (outbox/cursor/lock). */
    deviceId?: string
    /** Advanced persistence overrides (rare). */
    advanced?: SyncAdvancedArgs
    /** Sync.Store queued 写入策略（默认由 store.backend 推导） */
    queueWriteMode?: SyncQueueWriteMode
    /** 是否启用 subscribe（默认：true） */
    subscribe?: boolean
    /** SSE event name（默认：Protocol.sse.events.NOTIFY） */
    subscribeEventName?: string
    /** 同步资源过滤（默认：不过滤；服务端返回所有 changes） */
    resources?: string[]
    maxQueueSize?: number
    maxPushItems?: number
    pullLimit?: number
    pullDebounceMs?: number
    reconnectDelayMs?: number
    periodicPullIntervalMs?: number
    inFlightTimeoutMs?: number
    retry?: HttpBackendConfig['retry']
    backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
    now?: () => number
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    returning?: boolean
    /** outbox 事件（例如队列大小变化） */
    outboxEvents?: SyncOutboxEvents
    onError?: (error: Error, context: { phase: SyncPhase }) => void
    onEvent?: (event: SyncEvent) => void
}
