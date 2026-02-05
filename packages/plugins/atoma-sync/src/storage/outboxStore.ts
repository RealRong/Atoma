import { openDB } from 'idb'
import type { IDBPDatabase } from 'idb'
import type { OutboxStore, OutboxWrite, SyncOutboxEvents, SyncOutboxItem, SyncOutboxStats } from 'atoma-types/sync'

type OutboxStatus = 'pending' | 'in_flight'

type PersistedOutboxEntry = {
    pk: string
    outboxKey: string
    idempotencyKey: string
    resource: string
    action: string
    item: any
    enqueuedAtMs: number
    status: OutboxStatus
    inFlightAtMs?: number
    entityId?: string
}

const DEFAULT_DB_NAME = 'atoma-sync-db'
const KV_STORE_NAME = 'sync'
const OUTBOX_STORE_NAME = 'outbox_entries'
const OUTBOX_INDEX_BY_OUTBOX = 'by_outbox'
const OUTBOX_INDEX_BY_OUTBOX_STATUS_ENQUEUED = 'by_outbox_status_enqueued'
const OUTBOX_INDEX_BY_OUTBOX_STATUS_INFLIGHT_AT = 'by_outbox_status_inFlightAt'
const OUTBOX_INDEX_BY_OUTBOX_STATUS_RESOURCE_ENTITY_ENQUEUED = 'by_outbox_status_resource_entity_enqueued'
const DB_VERSION = 2
const MIN_TIME_MS = 0
const MAX_TIME_MS = Number.MAX_SAFE_INTEGER

function ensureOutboxSchema(db: IDBPDatabase<any>) {
    if (!db.objectStoreNames.contains(KV_STORE_NAME)) {
        db.createObjectStore(KV_STORE_NAME)
    }

    if (db.objectStoreNames.contains(OUTBOX_STORE_NAME)) return

    const store = db.createObjectStore(OUTBOX_STORE_NAME, { keyPath: 'pk' })
    store.createIndex(OUTBOX_INDEX_BY_OUTBOX, 'outboxKey')
    store.createIndex(OUTBOX_INDEX_BY_OUTBOX_STATUS_ENQUEUED, ['outboxKey', 'status', 'enqueuedAtMs'])
    store.createIndex(OUTBOX_INDEX_BY_OUTBOX_STATUS_INFLIGHT_AT, ['outboxKey', 'status', 'inFlightAtMs'])
    store.createIndex(OUTBOX_INDEX_BY_OUTBOX_STATUS_RESOURCE_ENTITY_ENQUEUED, ['outboxKey', 'status', 'resource', 'entityId', 'enqueuedAtMs'])
}

async function openSyncDb(): Promise<IDBPDatabase<any>> {
    return openDB(DEFAULT_DB_NAME, DB_VERSION, {
        upgrade(db) {
            // Note: we intentionally do not migrate old KV-based outbox state.
            // This package is currently internal-only; breaking persistence is acceptable.
            ensureOutboxSchema(db)
        }
    })
}

export class DefaultOutboxStore implements OutboxStore {
    private events?: SyncOutboxEvents
    private initialized: Promise<void>
    private cachedStats: SyncOutboxStats | null = null
    private readonly memory?: MemoryOutboxStore

    constructor(
        private readonly storageKey: string,
        private readonly maxQueueSize: number = 1000,
        private readonly now: () => number = () => Date.now(),
        private readonly inFlightTimeoutMs: number = 30_000
    ) {
        if (typeof indexedDB === 'undefined') {
            this.memory = new MemoryOutboxStore(this.storageKey, this.maxQueueSize, this.now)
            this.memory.setEvents(this.events)
            this.initialized = Promise.resolve()
        } else {
            this.initialized = this.init()
        }
    }

    setEvents(events?: SyncOutboxEvents) {
        this.events = events
        this.memory?.setEvents(events)
    }

    private async init() {
        await openSyncDb()
        await this.recover({ nowMs: this.now(), inFlightTimeoutMs: this.inFlightTimeoutMs })
        await this.refreshStats()
    }

    async enqueueWrites(args: { writes: OutboxWrite[] }) {
        await this.initialized
        if (this.memory) return this.memory.enqueueWrites(args)

        const now = this.now()
        const items: SyncOutboxItem[] = []

        for (const write of args.writes) {
            const resource = String((write as any)?.resource ?? '')
            const action = (write as any)?.action as any
            const baseItem = (write as any)?.item as any

            if (!resource || !action || !baseItem) {
                throw new Error('[Sync] enqueueWrites requires { resource, action, item }')
            }

            const meta = this.requireItemMeta(baseItem)
            const ensuredItem = { ...(baseItem as any), meta } as any

            const entry = {
                idempotencyKey: meta.idempotencyKey!,
                resource,
                action,
                item: ensuredItem,
                enqueuedAtMs: now
            } as SyncOutboxItem
            items.push(entry)
        }

        if (!items.length) return []

        const db = await openSyncDb()
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite')
        const store = tx.store

        const maxQueueSize = Math.max(1, Math.floor(this.maxQueueSize))
        const currentTotal = await store.index(OUTBOX_INDEX_BY_OUTBOX).count(this.storageKey)
        if (currentTotal + items.length > maxQueueSize) {
            const stats = await this.stats()
            this.events?.onQueueFull?.(stats, maxQueueSize)
            throw new Error(`[Sync] outbox is full (maxQueueSize=${maxQueueSize})`)
        }

        const insertedKeys: string[] = []

        for (const item of items) {
            const pk = this.pk(item.idempotencyKey)
            const existing = await store.get(pk)
            if (existing) continue

            const entityId = this.extractEntityId(item.item)
            const persisted: PersistedOutboxEntry = {
                pk,
                outboxKey: this.storageKey,
                idempotencyKey: item.idempotencyKey,
                resource: item.resource,
                action: item.action,
                item: item.item,
                enqueuedAtMs: item.enqueuedAtMs,
                status: 'pending',
                ...(entityId ? { entityId } : {})
            }
            await store.put(persisted)
            insertedKeys.push(item.idempotencyKey)
        }

        await tx.done
        await this.bumpStats({ pendingDelta: insertedKeys.length, inFlightDelta: 0, totalDelta: insertedKeys.length })
        return insertedKeys
    }

    async reserve(args: { limit: number; nowMs: number }): Promise<SyncOutboxItem[]> {
        await this.initialized
        if (this.memory) return this.memory.reserve(args)

        const limit = Math.max(1, Math.floor(args.limit))
        const nowMs = Math.max(0, Math.floor(args.nowMs))

        const db = await openSyncDb()
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite')
        const store = tx.store
        const index = store.index(OUTBOX_INDEX_BY_OUTBOX_STATUS_ENQUEUED)

        const range = IDBKeyRange.bound(
            [this.storageKey, 'pending', MIN_TIME_MS],
            [this.storageKey, 'pending', MAX_TIME_MS]
        )

        const out: SyncOutboxItem[] = []
        for (let cursor = await index.openCursor(range); cursor && out.length < limit; cursor = await cursor.continue()) {
            const raw = cursor.value as PersistedOutboxEntry
            const next: PersistedOutboxEntry = {
                ...raw,
                status: 'in_flight',
                inFlightAtMs: nowMs
            }
            await cursor.update(next)
            out.push(this.toSyncOutboxItem(raw))
        }

        await tx.done
        await this.bumpStats({ pendingDelta: -out.length, inFlightDelta: out.length, totalDelta: 0 })
        return out
    }

    async commit(args: {
        ack: string[]
        reject: string[]
        retryable: string[]
        rebase?: Array<{ resource: string; entityId: string; baseVersion: number; afterEnqueuedAtMs?: number }>
    }): Promise<void> {
        await this.initialized
        if (this.memory) return this.memory.commit(args)

        const ackSet = new Set([...(args.ack ?? []), ...(args.reject ?? [])])
        const retrySet = new Set(args.retryable ?? [])

        if (!ackSet.size && !retrySet.size && (!args.rebase || !args.rebase.length)) return

        const db = await openSyncDb()
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite')
        const store = tx.store
        const index = store.index(OUTBOX_INDEX_BY_OUTBOX_STATUS_RESOURCE_ENTITY_ENQUEUED)

        for (const idempotencyKey of ackSet) {
            await store.delete(this.pk(idempotencyKey))
        }

        for (const idempotencyKey of retrySet) {
            const pk = this.pk(idempotencyKey)
            const existing = await store.get(pk)
            if (!existing) continue
            const next: PersistedOutboxEntry = {
                ...(existing as any),
                status: 'pending',
                inFlightAtMs: undefined
            }
            await store.put(next)
        }

        if (Array.isArray(args.rebase)) {
            for (const r of args.rebase) {
                const resource = String((r as any)?.resource ?? '')
                const entityId = String((r as any)?.entityId ?? '')
                const baseVersion = (r as any)?.baseVersion
                const after = (typeof (r as any)?.afterEnqueuedAtMs === 'number' && Number.isFinite((r as any)?.afterEnqueuedAtMs))
                    ? Math.floor((r as any).afterEnqueuedAtMs)
                    : undefined

                if (!resource || !entityId) continue
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) continue

                const range = IDBKeyRange.bound(
                    [this.storageKey, 'pending', resource, entityId, MIN_TIME_MS],
                    [this.storageKey, 'pending', resource, entityId, MAX_TIME_MS]
                )

                for (let cursor = await index.openCursor(range); cursor; cursor = await cursor.continue()) {
                    const raw = cursor.value as PersistedOutboxEntry
                    const item: any = raw.item
                    if (after !== undefined && raw.enqueuedAtMs <= after) continue
                    if (typeof item?.baseVersion !== 'number' || !Number.isFinite(item.baseVersion) || item.baseVersion <= 0) continue
                    if (item.baseVersion >= baseVersion) continue

                    const next: PersistedOutboxEntry = {
                        ...raw,
                        item: {
                            ...(item as any),
                            baseVersion
                        }
                    }
                    await cursor.update(next)
                }
            }
        }

        await tx.done

        const ackCount = ackSet.size
        const retryCount = retrySet.size
        if (ackCount || retryCount) {
            await this.bumpStats({
                pendingDelta: retryCount,
                inFlightDelta: -retryCount,
                totalDelta: -ackCount
            })
        }
    }

    async recover(args: { nowMs: number; inFlightTimeoutMs: number }): Promise<void> {
        await this.initialized
        if (this.memory) return this.memory.recover(args)

        const nowMs = Math.max(0, Math.floor(args.nowMs))
        const timeout = Math.max(0, Math.floor(args.inFlightTimeoutMs))
        if (!timeout) return

        const db = await openSyncDb()
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite')
        const store = tx.store
        const index = store.index(OUTBOX_INDEX_BY_OUTBOX_STATUS_INFLIGHT_AT)

        const range = IDBKeyRange.bound(
            [this.storageKey, 'in_flight', MIN_TIME_MS],
            [this.storageKey, 'in_flight', MAX_TIME_MS]
        )

        let released = 0
        for (let cursor = await index.openCursor(range); cursor; cursor = await cursor.continue()) {
            const raw = cursor.value as PersistedOutboxEntry
            const inFlightAtMs = raw.inFlightAtMs ?? 0
            if (inFlightAtMs + timeout > nowMs) continue

            const next: PersistedOutboxEntry = {
                ...raw,
                status: 'pending',
                inFlightAtMs: undefined
            }
            await cursor.update(next)
            released++
        }

        await tx.done

        if (released) {
            await this.bumpStats({ pendingDelta: released, inFlightDelta: -released, totalDelta: 0 })
        }
    }

    async stats(): Promise<SyncOutboxStats> {
        await this.initialized
        if (this.memory) return this.memory.stats()

        const cached = this.cachedStats
        if (cached) return cached
        return this.refreshStats()
    }

    private async refreshStats(): Promise<SyncOutboxStats> {
        const db = await openSyncDb()
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readonly')
        const store = tx.store
        const byOutbox = store.index(OUTBOX_INDEX_BY_OUTBOX)
        const byStatus = store.index(OUTBOX_INDEX_BY_OUTBOX_STATUS_ENQUEUED)
        const byInFlight = store.index(OUTBOX_INDEX_BY_OUTBOX_STATUS_INFLIGHT_AT)

        const total = await byOutbox.count(this.storageKey)
        const pending = await byStatus.count(IDBKeyRange.bound(
            [this.storageKey, 'pending', MIN_TIME_MS],
            [this.storageKey, 'pending', MAX_TIME_MS]
        ))
        const inFlight = await byInFlight.count(IDBKeyRange.bound(
            [this.storageKey, 'in_flight', MIN_TIME_MS],
            [this.storageKey, 'in_flight', MAX_TIME_MS]
        ))

        await tx.done

        const stats = { pending, inFlight, total }
        this.cachedStats = stats
        this.events?.onQueueChange?.(stats)
        return stats
    }

    private async bumpStats(args: { pendingDelta: number; inFlightDelta: number; totalDelta: number }) {
        const cur = this.cachedStats ?? await this.refreshStats()
        const next: SyncOutboxStats = {
            pending: Math.max(0, cur.pending + Math.floor(args.pendingDelta)),
            inFlight: Math.max(0, cur.inFlight + Math.floor(args.inFlightDelta)),
            total: Math.max(0, cur.total + Math.floor(args.totalDelta))
        }
        this.cachedStats = next
        this.events?.onQueueChange?.(next)
    }

    private pk(idempotencyKey: string): string {
        return `${this.storageKey}::${idempotencyKey}`
    }

    private toSyncOutboxItem(raw: PersistedOutboxEntry): SyncOutboxItem {
        return {
            idempotencyKey: raw.idempotencyKey,
            resource: raw.resource,
            action: raw.action as any,
            item: raw.item as any,
            enqueuedAtMs: raw.enqueuedAtMs
        }
    }

    private extractEntityId(item: any): string | undefined {
        const id = item?.entityId
        return (typeof id === 'string' && id) ? id : undefined
    }

    private requireItemMeta(item: any) {
        const meta = (item as any)?.meta
        if (!meta || typeof meta !== 'object') {
            throw new Error('[Sync] write item meta is required for enqueueWrites')
        }
        if (typeof (meta as any).idempotencyKey !== 'string' || !(meta as any).idempotencyKey) {
            throw new Error('[Sync] write item meta.idempotencyKey is required for enqueueWrites')
        }
        if (typeof (meta as any).clientTimeMs !== 'number' || !Number.isFinite((meta as any).clientTimeMs)) {
            throw new Error('[Sync] write item meta.clientTimeMs is required for enqueueWrites')
        }
        return meta as any
    }
}

class MemoryOutboxStore {
    private events?: SyncOutboxEvents
    private readonly byKey = new Map<string, SyncOutboxItem & { status: OutboxStatus; inFlightAtMs?: number }>()
    private readonly order: Array<string> = []

    constructor(
        private readonly outboxKey: string,
        private readonly maxQueueSize: number,
        private readonly now: () => number
    ) {}

    setEvents(events?: SyncOutboxEvents) {
        this.events = events
    }

    async enqueueWrites(args: { writes: OutboxWrite[] }): Promise<string[]> {
        const now = this.now()
        const maxQueueSize = Math.max(1, Math.floor(this.maxQueueSize))

        const inserted: string[] = []
        for (const write of args.writes) {
            const resource = String((write as any)?.resource ?? '')
            const action = (write as any)?.action as any
            const baseItem = (write as any)?.item as any

            if (!resource || !action || !baseItem) {
                throw new Error('[Sync] enqueueWrites requires { resource, action, item }')
            }

            const meta = (baseItem as any)?.meta
            const key = meta?.idempotencyKey
            if (typeof key !== 'string' || !key) throw new Error('[Sync] write item meta.idempotencyKey is required for enqueueWrites')

            if (this.byKey.has(key)) continue
            if (this.byKey.size >= maxQueueSize) {
                const stats = await this.stats()
                this.events?.onQueueFull?.(stats, maxQueueSize)
                throw new Error(`[Sync] outbox is full (maxQueueSize=${maxQueueSize})`)
            }

            const entry: SyncOutboxItem & { status: OutboxStatus; inFlightAtMs?: number } = {
                idempotencyKey: key,
                resource,
                action,
                item: baseItem,
                enqueuedAtMs: now,
                status: 'pending',
                inFlightAtMs: undefined
            }
            this.byKey.set(key, entry)
            this.order.push(key)
            inserted.push(key)
        }

        if (inserted.length) {
            this.events?.onQueueChange?.(await this.stats())
        }

        return inserted
    }

    async reserve(args: { limit: number; nowMs: number }): Promise<SyncOutboxItem[]> {
        const limit = Math.max(1, Math.floor(args.limit))
        const nowMs = Math.max(0, Math.floor(args.nowMs))

        const out: SyncOutboxItem[] = []
        for (const key of this.order) {
            if (out.length >= limit) break
            const entry = this.byKey.get(key)
            if (!entry) continue
            if (entry.status !== 'pending') continue
            entry.status = 'in_flight'
            entry.inFlightAtMs = nowMs
            out.push({
                idempotencyKey: entry.idempotencyKey,
                resource: entry.resource,
                action: entry.action,
                item: entry.item,
                enqueuedAtMs: entry.enqueuedAtMs
            })
        }

        if (out.length) {
            this.events?.onQueueChange?.(await this.stats())
        }
        return out
    }

    async commit(args: { ack: string[]; reject: string[]; retryable: string[]; rebase?: Array<{ resource: string; entityId: string; baseVersion: number; afterEnqueuedAtMs?: number }> }): Promise<void> {
        const ackSet = new Set([...(args.ack ?? []), ...(args.reject ?? [])])
        const retrySet = new Set(args.retryable ?? [])

        for (const key of ackSet) {
            this.byKey.delete(key)
        }
        for (const key of retrySet) {
            const e = this.byKey.get(key)
            if (!e) continue
            e.status = 'pending'
            e.inFlightAtMs = undefined
        }

        if (Array.isArray(args.rebase)) {
            for (const r of args.rebase) {
                const resource = String((r as any)?.resource ?? '')
                const entityId = String((r as any)?.entityId ?? '')
                const baseVersion = (r as any)?.baseVersion
                const after = (typeof (r as any)?.afterEnqueuedAtMs === 'number' && Number.isFinite((r as any)?.afterEnqueuedAtMs))
                    ? Math.floor((r as any).afterEnqueuedAtMs)
                    : undefined

                if (!resource || !entityId) continue
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) continue

                for (const key of this.order) {
                    const e = this.byKey.get(key)
                    if (!e || e.status !== 'pending') continue
                    if (after !== undefined && e.enqueuedAtMs <= after) continue
                    if (e.resource !== resource) continue
                    const item: any = e.item
                    if (item?.entityId !== entityId) continue
                    if (typeof item.baseVersion !== 'number' || !Number.isFinite(item.baseVersion) || item.baseVersion <= 0) continue
                    if (item.baseVersion < baseVersion) {
                        item.baseVersion = baseVersion
                    }
                }
            }
        }

        this.events?.onQueueChange?.(await this.stats())
    }

    async recover(args: { nowMs: number; inFlightTimeoutMs: number }): Promise<void> {
        const nowMs = Math.max(0, Math.floor(args.nowMs))
        const timeout = Math.max(0, Math.floor(args.inFlightTimeoutMs))
        if (!timeout) return

        let changed = false
        for (const key of this.order) {
            const e = this.byKey.get(key)
            if (!e) continue
            if (e.status !== 'in_flight') continue
            if (typeof e.inFlightAtMs !== 'number') continue
            if (e.inFlightAtMs + timeout <= nowMs) {
                e.status = 'pending'
                e.inFlightAtMs = undefined
                changed = true
            }
        }
        if (changed) {
            this.events?.onQueueChange?.(await this.stats())
        }
    }

    async stats(): Promise<SyncOutboxStats> {
        let pending = 0
        let inFlight = 0
        for (const e of this.byKey.values()) {
            if (e.status === 'pending') pending++
            if (e.status === 'in_flight') inFlight++
        }
        return { pending, inFlight, total: this.byKey.size }
    }
}
