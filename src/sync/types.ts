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
    WriteOptions,
} from '#protocol'
import type { OpsClient } from '../backend/OpsClient'

export type SyncOutboxItem = {
    idempotencyKey: string
    resource: string
    action: WriteAction
    item: WriteItem
    options?: WriteOptions
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

export type NotifyMessage = {
    resources?: string[]
    traceId?: string
}

export interface SyncTransport {
    opsClient: OpsClient
    subscribe: (args: {
        resources?: string[]
        onMessage: (msg: NotifyMessage) => void
        onError: (error: unknown) => void
    }) => { close: () => void }
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
    transport: SyncTransport
    onPullChanges?: (changes: Change[]) => Promise<void> | void
    onWriteAck?: (ack: SyncWriteAck) => Promise<void> | void
    onWriteReject?: (reject: SyncWriteReject, conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual') => Promise<void> | void
    outboxKey: string
    cursorKey: string
    maxQueueSize?: number
    outboxEvents?: SyncOutboxEvents
    maxPushItems?: number
    pullLimit?: number
    pullDebounceMs?: number
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
        options?: WriteOptions
    }) => Promise<string[]>
    flush: () => Promise<void>
    pull: () => Promise<ChangeBatch | undefined>
    setSubscribed: (enabled: boolean) => void
}
