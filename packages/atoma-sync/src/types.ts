import type {
    Change,
    ChangeBatch,
    Cursor,
    Meta,
    WriteItemResult,
} from 'atoma/protocol'

export type OutboxWrite = {
    resource: string
    action: OutboxWriteAction
    item: OutboxWriteItem
    options?: any
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
    options?: any
    enqueuedAtMs: number
}

export type OutboxQueueMode = 'queue' | 'local-first'

export type OutboxWriter = Readonly<{
    queueMode: OutboxQueueMode
    enqueueWrites: (args: { writes: OutboxWrite[] }) => Promise<string[]>
}>

export type OutboxReader = Readonly<{
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
}>

export type OutboxEvents = Readonly<{
    setEvents?: (events?: SyncOutboxEvents) => void
}>

export type OutboxStore = OutboxWriter & OutboxReader & OutboxEvents

export interface CursorStore {
    get: () => Promise<Cursor | undefined> | Cursor | undefined
    set: (next: Cursor) => Promise<boolean> | boolean
}

export type SyncWriteAck = {
    resource: string
    action: import('atoma/protocol').WriteAction
    item: import('atoma/protocol').WriteItem
    result: Extract<WriteItemResult, { ok: true }>
}

export type SyncWriteReject = {
    resource: string
    action: import('atoma/protocol').WriteAction
    item: import('atoma/protocol').WriteItem
    result: Extract<WriteItemResult, { ok: false }>
}

export type SyncPushOutcome =
    | { kind: 'ack'; result: Extract<WriteItemResult, { ok: true }> }
    | { kind: 'reject'; result: Extract<WriteItemResult, { ok: false }> }
    | { kind: 'retry'; error: unknown }

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
    pullChanges: (args: {
        cursor: Cursor
        limit: number
        resources?: string[]
        meta: Meta
    }) => Promise<ChangeBatch>
    pushWrites: (args: {
        entries: SyncOutboxItem[]
        meta: Meta
        returning: boolean
    }) => Promise<SyncPushOutcome[]>
    subscribe?: SyncSubscribe
}

export type SyncPhase = 'push' | 'pull' | 'notify' | 'lifecycle'

export type SyncEvent =
    | { type: 'lifecycle:starting' }
    | { type: 'lifecycle:started' }
    | { type: 'lifecycle:stopped' }
    | { type: 'lifecycle:lock_failed'; error: Error }
    | { type: 'lifecycle:lock_lost'; error: Error }
    | { type: 'outbox:queue'; size: number }
    | { type: 'outbox:queue_full'; droppedOp: SyncOutboxItem; maxQueueSize: number }
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

export type SyncMode = 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full'

export type SyncResolvedLaneConfig = {
    retry: SyncRetryConfig
    backoff: SyncBackoffConfig
}

export type SyncRuntimeConfig = {
    transport: SyncTransport
    applier: SyncApplier
    outbox?: OutboxReader & OutboxEvents
    outboxEvents?: SyncOutboxEvents
    cursor: CursorStore

    push: {
        enabled: boolean
        maxItems: number
        returning: boolean
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
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
    flush: () => Promise<void>
    pull: () => Promise<ChangeBatch | undefined>
}
