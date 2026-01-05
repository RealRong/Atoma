import type { SyncEvent, SyncOutboxEvents, SyncPhase, SyncOutboxItem } from '#sync'

export type SyncQueueWriteMode = 'intent-only' | 'local-first'

export type SyncQueueWritesArgs = {
    outboxKey?: string
    maxSize?: number
    onQueueChange?: (size: number) => void
    onQueueFull?: (args: { maxSize: number; droppedOp: SyncOutboxItem }) => void
}

export type SyncDefaultsArgs = {
    resources?: string[]
    cursorKey?: string
    returning?: boolean
    subscribe?: boolean
    subscribeEventName?: string
    pullLimit?: number
    pullDebounceMs?: number
    periodicPullIntervalMs?: number
    reconnectDelayMs?: number
    inFlightTimeoutMs?: number
    retry?: { maxAttempts?: number }
    backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
    lockKey?: string
    lockTtlMs?: number
    lockRenewIntervalMs?: number
    now?: () => number
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    onEvent?: (event: any) => void
    onError?: (error: Error, context: any) => void
}

export type AtomaClientSyncConfig = {
    /** Sync.Store queued 写入策略（默认由 store.backend 推导） */
    queueWriteMode?: SyncQueueWriteMode
    /** 是否启用 subscribe（默认：true） */
    subscribe?: boolean
    /** SSE event name（默认：Protocol.sse.events.NOTIFY） */
    subscribeEventName?: string
    /** 同步资源过滤（默认：不过滤；服务端返回所有 changes） */
    resources?: string[]
    /** outbox/cursor 存储 key（默认：基于 backend.key + 标签页 instanceId 生成） */
    outboxKey?: string
    cursorKey?: string
    maxQueueSize?: number
    maxPushItems?: number
    pullLimit?: number
    pullDebounceMs?: number
    reconnectDelayMs?: number
    periodicPullIntervalMs?: number
    inFlightTimeoutMs?: number
    retry?: { maxAttempts?: number }
    backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
    lockKey?: string
    lockTtlMs?: number
    lockRenewIntervalMs?: number
    now?: () => number
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    returning?: boolean
    /** outbox 事件（例如队列大小变化） */
    outboxEvents?: SyncOutboxEvents
    onError?: (error: Error, context: { phase: SyncPhase }) => void
    onEvent?: (event: SyncEvent) => void
}
