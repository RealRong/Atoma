import type {
    Change,
    ChangeBatch,
    Cursor,
    Meta,
    WriteItemResult,
} from '../protocol'

export type OutboxWrite = {
    resource: string
    action: OutboxWriteAction
    item: OutboxWriteItem
}

// Keep Outbox modeling protocol-shaped but protocol-independent.
export type OutboxWriteAction = 'create' | 'update' | 'delete' | 'upsert'

export type OutboxWriteItemMeta = {
    idempotencyKey?: string
    clientTimeMs?: number
    [k: string]: unknown
}

export type OutboxWriteItemCreate = {
    entityId?: string
    value: unknown
    meta?: OutboxWriteItemMeta
}

export type OutboxWriteItemUpdate = {
    entityId: string
    baseVersion: number
    value: unknown
    meta?: OutboxWriteItemMeta
}

export type OutboxWriteItemUpsert = {
    entityId: string
    baseVersion?: number
    value: unknown
    meta?: OutboxWriteItemMeta
}

export type OutboxWriteItemDelete = {
    entityId: string
    baseVersion: number
    meta?: OutboxWriteItemMeta
}

export type OutboxWriteItem =
    | OutboxWriteItemCreate
    | OutboxWriteItemUpdate
    | OutboxWriteItemDelete
    | OutboxWriteItemUpsert

export type SyncOutboxItem = {
    idempotencyKey: string
    /** 要推送的写入意图（PushLane 在发送前会构建为协议 op） */
    resource: string
    action: OutboxWriteAction
    item: OutboxWriteItem
    enqueuedAtMs: number
}

export type SyncOutboxStats = Readonly<{
    pending: number
    inFlight: number
    total: number
}>

export type SyncOutboxEvents = {
    onQueueChange?: (stats: SyncOutboxStats) => void
    onQueueFull?: (stats: SyncOutboxStats, maxQueueSize: number) => void
}

export interface OutboxStore {
    enqueueWrites: (args: { writes: OutboxWrite[] }) => Promise<string[]>

    /**
     * Atomically reserves up to `limit` pending entries and marks them in-flight.
     * Returned entries are protocol-shaped write intents (same as previously returned by `peek()`).
     */
    reserve: (args: { limit: number; nowMs: number }) => Promise<SyncOutboxItem[]>

    /**
     * Commits the outcomes for a previously reserved batch.
     * - ack/reject: remove from outbox
     * - retryable: move back to pending (clears inFlight marker)
     * - rebase: optional virtual baseVersion rewrite for subsequent pending writes
     */
    commit: (args: {
        ack: string[]
        reject: string[]
        retryable: string[]
        rebase?: Array<{ resource: string; entityId: string; baseVersion: number; afterEnqueuedAtMs?: number }>
    }) => Promise<void>

    /** Crash recovery: releases stale in-flight entries back to pending. */
    recover: (args: { nowMs: number; inFlightTimeoutMs: number }) => Promise<void>

    stats: () => Promise<SyncOutboxStats>

    setEvents?: (events?: SyncOutboxEvents) => void
}

export interface CursorStore {
    get: () => Promise<Cursor | undefined> | Cursor | undefined
    advance: (next: Cursor) => Promise<{ advanced: boolean; previous?: Cursor }> | { advanced: boolean; previous?: Cursor }
}

export type SyncWriteAck = {
    resource: string
    action: import('../protocol').WriteAction
    item: import('../protocol').WriteItem
    result: Extract<WriteItemResult, { ok: true }>
}

export type SyncWriteReject = {
    resource: string
    action: import('../protocol').WriteAction
    item: import('../protocol').WriteItem
    result: Extract<WriteItemResult, { ok: false }>
}

export type SyncPushOutcome =
    | { kind: 'ack'; result: Extract<WriteItemResult, { ok: true }> }
    | { kind: 'reject'; result: Extract<WriteItemResult, { ok: false }> }
    | { kind: 'retry'; error: unknown }

export interface SyncApplier {
    applyPullChanges: (changes: Change[]) => Promise<void> | void
    applyWriteAck: (ack: SyncWriteAck) => Promise<void> | void
    applyWriteReject: (reject: SyncWriteReject) => Promise<void> | void
    /**
     * Optional batch apply for push outcomes.
     * When implemented, it SHOULD be atomic (e.g. a single transaction) to avoid partial apply.
     */
    atomicBatchApply?: boolean
    applyWriteResults?: (args: {
        acks: SyncWriteAck[]
        rejects: SyncWriteReject[]
        signal?: AbortSignal
    }) => Promise<void> | void
}

export type NotifyMessage = import('../protocol').NotifyMessage

export type SyncSubscribe = (args: {
    resources?: string[]
    onMessage: (msg: NotifyMessage) => void
    onError: (error: unknown) => void
    signal?: AbortSignal
}) => { close: () => void }

export interface SyncTransport {
    pullChanges: (args: {
        cursor: Cursor
        limit: number
        resources?: string[]
        meta: Meta
        signal?: AbortSignal
    }) => Promise<ChangeBatch>
    pushWrites: (args: {
        entries: SyncOutboxItem[]
        meta: Meta
        returning: boolean
        signal?: AbortSignal
    }) => Promise<SyncPushOutcome[]>
}

export type SyncDriver = SyncTransport

export interface SyncSubscribeTransport {
    subscribe: SyncSubscribe
}

export type SyncSubscribeDriver = SyncSubscribeTransport

export type SyncPhase = 'push' | 'pull' | 'notify' | 'lifecycle'

export type SyncEvent =
    | { type: 'lifecycle:starting' }
    | { type: 'lifecycle:started' }
    | { type: 'lifecycle:stopped' }
    | { type: 'lifecycle:lock_failed'; error: Error }
    | { type: 'lifecycle:lock_lost'; error: Error }
    | { type: 'outbox:queue'; stats: SyncOutboxStats }
    | { type: 'outbox:queue_full'; stats: SyncOutboxStats; maxQueueSize: number }
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

export type SyncBackoffConfig = {
    baseDelayMs?: number
    maxDelayMs?: number
    jitterRatio?: number
}

export type SyncRetryConfig = {
    maxAttempts?: number
}

export type SyncMode = 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full'

export type SyncResolvedLaneConfig = {
    retry: SyncRetryConfig
    backoff: SyncBackoffConfig
}

export type SyncRuntimeConfig = {
    transport: SyncTransport
    subscribeTransport?: SyncSubscribeTransport
    applier: SyncApplier
    outbox: OutboxStore
    cursor: CursorStore

    push: {
        enabled: boolean
        maxItems: number
        returning: boolean
        retry: SyncRetryConfig
        backoff: SyncBackoffConfig
    }

    pull: {
        enabled: boolean
        limit: number
        debounceMs: number
        resources?: string[]
        initialCursor?: Cursor
        periodic: {
            intervalMs: number
            retry: SyncRetryConfig
            backoff: SyncBackoffConfig
        }
    }

    subscribe: {
        enabled: boolean
        reconnectDelayMs: number
        retry: SyncRetryConfig
        backoff: SyncBackoffConfig
    }

    lock: {
        key: string
        ttlMs?: number
        renewIntervalMs?: number
        backoff: SyncBackoffConfig
    }
    now?: () => number
    onError?: (error: Error, context: { phase: SyncPhase }) => void
    onEvent?: (event: SyncEvent) => void
}

export interface SyncClient {
    start: () => void
    stop: () => void
    dispose: () => void
    push: () => Promise<void>
    pull: () => Promise<ChangeBatch | undefined>
}
