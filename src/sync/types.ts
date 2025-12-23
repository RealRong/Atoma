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

export type SyncOutboxItem = {
    idempotencyKey: string
    resource: string
    action: WriteAction
    item: WriteItem
    enqueuedAtMs: number
}

export interface OutboxStore {
    enqueue: (items: SyncOutboxItem[]) => Promise<void> | void
    peek: (limit: number) => Promise<SyncOutboxItem[]> | SyncOutboxItem[]
    ack: (idempotencyKeys: string[]) => Promise<void> | void
    reject: (idempotencyKeys: string[], reason?: unknown) => Promise<void> | void
    markInFlight?: (idempotencyKeys: string[], atMs: number) => Promise<void> | void
    releaseInFlight?: (idempotencyKeys: string[]) => Promise<void> | void
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

export interface SyncTransport {
    executeOps: (args: {
        ops: Operation[]
        meta: Meta
    }) => Promise<OperationResult[]>
    subscribe: (args: {
        cursor: Cursor
        onBatch: (batch: ChangeBatch) => void
        onError: (error: unknown) => void
    }) => { close: () => void }
}

export type SyncPhase = 'push' | 'pull' | 'subscribe' | 'lifecycle'

export type SyncEvent =
    | { type: 'lifecycle:starting' }
    | { type: 'lifecycle:started' }
    | { type: 'lifecycle:stopped' }
    | { type: 'lifecycle:lock_failed'; error: Error }
    | { type: 'lifecycle:lock_lost'; error: Error }
    | { type: 'push:start' }
    | { type: 'push:idle' }
    | { type: 'push:backoff'; attempt: number; delayMs: number }
    | { type: 'pull:start' }
    | { type: 'pull:idle' }
    | { type: 'pull:backoff'; attempt: number; delayMs: number }
    | { type: 'subscribe:connected' }
    | { type: 'subscribe:backoff'; attempt: number; delayMs: number }
    | { type: 'subscribe:stopped' }

export type SyncOutboxEvents = {
    onQueueChange?: (size: number) => void
    onQueueFull?: (droppedOp: SyncOutboxItem, maxSize: number) => void
}

export type SyncBackoffConfig = {
    baseDelayMs?: number
    maxDelayMs?: number
    jitterRatio?: number
}

export type SyncRetryConfig = {
    maxAttempts?: number
}

export type SyncConfig = {
    executeOps: SyncTransport['executeOps']
    subscribeUrl?: (cursor: Cursor) => string
    eventSourceFactory?: (url: string) => EventSource
    subscribeEventName?: string
    onPullChanges?: (changes: Change[]) => Promise<void> | void
    onWriteAck?: (ack: SyncWriteAck) => Promise<void> | void
    onWriteReject?: (reject: SyncWriteReject, conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual') => Promise<void> | void
    outboxKey: string
    cursorKey: string
    maxQueueSize?: number
    outboxEvents?: SyncOutboxEvents
    maxPushItems?: number
    pullLimit?: number
    resources?: string[]
    initialCursor?: Cursor
    returning?: boolean
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    subscribe?: boolean
    reconnectDelayMs?: number
    periodicPullIntervalMs?: number
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
    enqueueWrite: (args: {
        resource: string
        action: WriteAction
        items: WriteItem[]
    }) => Promise<string[]>
    flush: () => Promise<void>
    pullNow: () => Promise<ChangeBatch | undefined>
    setSubscribed: (enabled: boolean) => void
}
