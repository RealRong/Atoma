import type {
    Change,
    ChangeBatch,
    Cursor,
    Meta,
    Operation,
    OperationResult,
    WriteAction,
    WriteItem,
    WriteItemResult,
} from '#protocol'
import type { OpsClient } from '#backend'

export type SyncOutboxItem = {
    idempotencyKey: string
    /** 已构建好的 op（必须为单 item 的 write op），PushLane 直接发送 */
    op: Operation
    enqueuedAtMs: number
}

export interface OutboxStore {
    enqueue: (items: SyncOutboxItem[]) => Promise<void> | void
    peek: (limit: number) => Promise<SyncOutboxItem[]> | SyncOutboxItem[]
    ack: (idempotencyKeys: string[]) => Promise<void> | void
    reject: (idempotencyKeys: string[], reason?: unknown) => Promise<void> | void
    markInFlight?: (idempotencyKeys: string[], atMs: number) => Promise<void> | void
    releaseInFlight?: (idempotencyKeys: string[]) => Promise<void> | void
    /**
     * Virtual baseVersion rewrite:
     * - 当某条写入已被服务端确认（拿到 version）后，把同 entity 的后续 outbox items 的 baseVersion 重写为该 version，
     *   以避免离线连续写导致的自冲突。
     */
    rebase?: (args: {
        resource: string
        entityId: string
        baseVersion: number
        afterEnqueuedAtMs?: number
    }) => Promise<void> | void
    size: () => Promise<number> | number
}

export interface CursorStore {
    get: () => Promise<Cursor | undefined> | Cursor | undefined
    set: (next: Cursor) => Promise<boolean> | boolean
}

export type SyncWriteAck = {
    resource: string
    action: WriteAction
    item: WriteItem
    result: Extract<WriteItemResult, { ok: true }>
}

export type SyncWriteReject = {
    resource: string
    action: WriteAction
    item: WriteItem
    result: Extract<WriteItemResult, { ok: false }>
}

export interface SyncApplier {
    applyPullChanges: (changes: Change[]) => Promise<void> | void
    applyWriteAck: (ack: SyncWriteAck) => Promise<void> | void
    applyWriteReject: (reject: SyncWriteReject, conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual') => Promise<void> | void
}

export type NotifyMessage = {
    resources?: string[]
    traceId?: string
}

export type SyncSubscribe = (args: {
    resources?: string[]
    onMessage: (msg: NotifyMessage) => void
    onError: (error: unknown) => void
}) => { close: () => void }

export interface SyncTransport {
    opsClient: OpsClient
    subscribe?: SyncSubscribe
}

export type SyncPhase = 'push' | 'pull' | 'notify' | 'lifecycle'

export type SyncEvent =
    | { type: 'lifecycle:starting' }
    | { type: 'lifecycle:started' }
    | { type: 'lifecycle:stopped' }
    | { type: 'lifecycle:lock_failed'; error: Error }
    | { type: 'lifecycle:lock_lost'; error: Error }
    | { type: 'push:start' }
    | { type: 'push:idle' }
    | { type: 'push:backoff'; attempt: number; delayMs: number }
    | { type: 'pull:scheduled'; cause: 'manual' | 'periodic' | 'notify' }
    | { type: 'pull:start' }
    | { type: 'pull:idle' }
    | { type: 'pull:backoff'; attempt: number; delayMs: number }
    | { type: 'notify:connected' }
    | { type: 'notify:message'; resources?: string[] }
    | { type: 'notify:backoff'; attempt: number; delayMs: number }
    | { type: 'notify:stopped' }

export type SyncOutboxEvents = {
    onQueueChange?: (size: number) => void
    onQueueFull?: (droppedOp: SyncOutboxItem, maxQueueSize: number) => void
}

export type SyncBackoffConfig = {
    baseDelayMs?: number
    maxDelayMs?: number
    jitterRatio?: number
}

export type SyncRetryConfig = {
    maxAttempts?: number
}

export type SyncMode = 'enqueue-only' | 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full'

export type SyncCreateConfig = {
    transport: SyncTransport
    applier: SyncApplier
    outboxKey: string
    cursorKey: string
    /** High-level behavior mode. Default: 'full' */
    mode?: SyncMode
    maxQueueSize?: number
    outboxEvents?: SyncOutboxEvents
    maxPushItems?: number
    pullLimit?: number
    pullDebounceMs?: number
    resources?: string[]
    initialCursor?: Cursor
    returning?: boolean
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    /** Whether to enable subscribe when mode wants it. Default: true */
    subscribe?: boolean
    reconnectDelayMs?: number
    pullIntervalMs?: number
    inFlightTimeoutMs?: number
    retry?: SyncRetryConfig
    backoff?: SyncBackoffConfig
    lockKey?: string
    lockTtlMs?: number
    lockRenewIntervalMs?: number
    now?: () => number
    onError?: (error: Error, context: { phase: SyncPhase }) => void
    onEvent?: (event: SyncEvent) => void
}

export interface SyncClient {
    start: () => void
    stop: () => void
    dispose: () => void
    enqueueOps: (args: { ops: Operation[] }) => Promise<string[]>
    flush: () => Promise<void>
    pull: () => Promise<ChangeBatch | undefined>
}
