import type { CursorStore, OutboxStore } from 'atoma-types/sync'
import { DefaultOutboxStore } from '#sync/storage/outbox-store'
import { DefaultCursorStore } from '#sync/storage/cursor-store'

export type SyncStoresConfig = {
    outboxKey: string
    cursorKey: string
    maxQueueSize?: number
    now?: () => number
    inFlightTimeoutMs?: number
}

export type SyncStores = {
    outbox: OutboxStore
    cursor: CursorStore
}

export function createStores(config: SyncStoresConfig): SyncStores {
    return {
        outbox: new DefaultOutboxStore(
            config.outboxKey,
            config.maxQueueSize ?? 1000,
            config.now ?? (() => Date.now()),
            config.inFlightTimeoutMs ?? 30_000
        ),
        cursor: new DefaultCursorStore(config.cursorKey)
    }
}

export { DefaultOutboxStore } from '#sync/storage/outbox-store'
export { DefaultCursorStore } from '#sync/storage/cursor-store'
