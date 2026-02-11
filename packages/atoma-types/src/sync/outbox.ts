import type { ResourceToken } from '../protocol'
import type { EntityId, Version } from '../shared'

export type OutboxWrite = {
    resource: ResourceToken
    action: OutboxWriteAction
    item: OutboxWriteItem
}

export type OutboxWriteAction = 'create' | 'update' | 'delete' | 'upsert'

export type OutboxWriteItemMeta = {
    idempotencyKey?: string
    clientTimeMs?: number
    [k: string]: unknown
}

export type OutboxWriteItemCreate = {
    entityId?: EntityId
    value: unknown
    meta?: OutboxWriteItemMeta
}

export type OutboxWriteItemUpdate = {
    entityId: EntityId
    baseVersion: Version
    value: unknown
    meta?: OutboxWriteItemMeta
}

export type OutboxWriteItemUpsert = {
    entityId: EntityId
    baseVersion?: Version
    value: unknown
    meta?: OutboxWriteItemMeta
}

export type OutboxWriteItemDelete = {
    entityId: EntityId
    baseVersion: Version
    meta?: OutboxWriteItemMeta
}

export type OutboxWriteItem =
    | OutboxWriteItemCreate
    | OutboxWriteItemUpdate
    | OutboxWriteItemDelete
    | OutboxWriteItemUpsert

export type SyncOutboxItem = {
    idempotencyKey: string
    resource: ResourceToken
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

    reserve: (args: { limit: number; nowMs: number }) => Promise<SyncOutboxItem[]>

    commit: (args: {
        ack: string[]
        reject: string[]
        retryable: string[]
        rebase?: Array<{ resource: ResourceToken; entityId: EntityId; baseVersion: Version; afterEnqueuedAtMs?: number }>
    }) => Promise<void>

    recover: (args: { nowMs: number; inFlightTimeoutMs: number }) => Promise<void>

    stats: () => Promise<SyncOutboxStats>

    setEvents?: (events?: SyncOutboxEvents) => void
}
