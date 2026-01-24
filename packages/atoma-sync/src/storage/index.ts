import type { CursorStore, OutboxStore } from '#sync/types'
import { DefaultOutboxStore } from '#sync/storage/outboxStore'
import { DefaultCursorStore } from '#sync/storage/cursorStore'

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

export { DefaultOutboxStore } from '#sync/storage/outboxStore'
export { DefaultCursorStore } from '#sync/storage/cursorStore'
