import type {
    VNextChange,
    VNextChangeBatch,
    VNextCursor,
    VNextMeta,
    VNextWriteAction,
    VNextWriteItem,
    VNextWriteItemResult,
    VNextWriteResultData
} from '#protocol'

export type SyncOutboxItem = {
    idempotencyKey: string
    resource: string
    action: VNextWriteAction
    item: VNextWriteItem
    enqueuedAtMs: number
}

export interface OutboxStore {
    enqueue: (items: SyncOutboxItem[]) => Promise<void> | void
    peek: (limit: number) => Promise<SyncOutboxItem[]> | SyncOutboxItem[]
    ack: (idempotencyKeys: string[]) => Promise<void> | void
    reject: (idempotencyKeys: string[], reason?: unknown) => Promise<void> | void
    size: () => Promise<number> | number
}

export interface CursorStore {
    get: () => Promise<VNextCursor | undefined> | VNextCursor | undefined
    set: (next: VNextCursor) => Promise<boolean> | boolean
}

export type SyncWriteAck = {
    resource: string
    action: VNextWriteAction
    item: VNextWriteItem
    result: Extract<VNextWriteItemResult, { ok: true }>
}

export type SyncWriteReject = {
    resource: string
    action: VNextWriteAction
    item: VNextWriteItem
    result: Extract<VNextWriteItemResult, { ok: false }>
}

export interface SyncApplier {
    applyChanges: (changes: VNextChange[]) => Promise<void> | void
    applyWriteAck: (ack: SyncWriteAck) => Promise<void> | void
    applyWriteReject: (reject: SyncWriteReject) => Promise<void> | void
}

export interface SyncTransport {
    push: (args: {
        opId: string
        resource: string
        action: VNextWriteAction
        items: VNextWriteItem[]
        options?: { returning?: boolean }
        meta: VNextMeta
    }) => Promise<VNextWriteResultData>
    pull: (args: { opId: string; cursor: VNextCursor; limit: number; resources?: string[]; meta: VNextMeta }) => Promise<VNextChangeBatch>
    subscribe: (args: {
        cursor: VNextCursor
        onBatch: (batch: VNextChangeBatch) => void
        onError: (error: unknown) => void
    }) => { close: () => void }
}

export type SyncEngineConfig = {
    transport: SyncTransport
    outbox: OutboxStore
    cursor: CursorStore
    applier: SyncApplier
    maxPushItems?: number
    pullLimit?: number
    resources?: string[]
    initialCursor?: VNextCursor
    returning?: boolean
    subscribe?: boolean
    reconnectDelayMs?: number
    now?: () => number
    onError?: (error: Error, context: { phase: 'push' | 'pull' | 'subscribe' }) => void
    onStateChange?: (state: 'idle' | 'pushing' | 'pulling' | 'subscribed' | 'backoff') => void
}
