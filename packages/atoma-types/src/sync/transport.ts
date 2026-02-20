import type {
    Change,
    ChangeBatch,
    Cursor,
    Meta,
    NotifyMessage,
    ResourceToken,
} from '../protocol'
import type { WriteEntry, WriteItemResult } from '../runtime'
import type { SyncOutboxItem } from './outbox'

export interface CursorStore {
    get: () => Promise<Cursor | undefined> | Cursor | undefined
    advance: (next: Cursor) => Promise<{ advanced: boolean; previous?: Cursor }> | { advanced: boolean; previous?: Cursor }
}

export type SyncWriteAck = {
    resource: ResourceToken
    entry: WriteEntry
    result: Extract<WriteItemResult, { ok: true }>
}

export type SyncWriteReject = {
    resource: ResourceToken
    entry: WriteEntry
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
    atomicBatchApply?: boolean
    applyWriteResults?: (args: {
        acks: SyncWriteAck[]
        rejects: SyncWriteReject[]
        signal?: AbortSignal
    }) => Promise<void> | void
}

export interface SyncTransport {
    pullChanges: (args: {
        cursor: Cursor
        limit: number
        resources?: ResourceToken[]
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

export interface SyncSubscribeTransport {
    subscribe: (args: {
        resources?: ResourceToken[]
        onMessage: (msg: NotifyMessage) => void
        onError: (error: unknown) => void
        signal?: AbortSignal
    }) => { close: () => void }
}

export type { NotifyMessage }
