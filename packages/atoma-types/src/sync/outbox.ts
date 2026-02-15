import type { ResourceToken } from '../protocol'
import type { WriteEntry } from '../runtime'
import type { EntityId, Version } from '../shared'

export type OutboxWrite = {
    resource: ResourceToken
    entry: WriteEntry
}

export type SyncOutboxItem = {
    idempotencyKey: string
    resource: ResourceToken
    entry: WriteEntry
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
