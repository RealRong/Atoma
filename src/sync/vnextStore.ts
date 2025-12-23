import { createKVStore } from './kvStore'
import type { OutboxStore, CursorStore, SyncOutboxItem } from './types'
import { defaultCompareCursor } from './policies/cursorGuard'
import type { Cursor } from '#protocol'
import type { SyncOutboxEvents } from './types'

export type VNextStoreConfig = {
    outboxKey: string
    cursorKey: string
    maxQueueSize?: number
    outboxEvents?: SyncOutboxEvents
    now?: () => number
    inFlightTimeoutMs?: number
}

export function createVNextStores(config: VNextStoreConfig): {
    outbox: VNextOutboxStore
    cursor: VNextCursorStore
} {
    return {
        outbox: new VNextOutboxStore(
            config.outboxKey,
            config.outboxEvents,
            config.maxQueueSize ?? 1000,
            config.now ?? (() => Date.now()),
            config.inFlightTimeoutMs ?? 30_000
        ),
        cursor: new VNextCursorStore(config.cursorKey)
    }
}

export class VNextOutboxStore implements OutboxStore {
    private readonly kv = createKVStore()
    private queue: Array<SyncOutboxItem & { inFlightAtMs?: number }> = []
    private byKey = new Map<string, SyncOutboxItem & { inFlightAtMs?: number }>()
    private initialized: Promise<void>

    constructor(
        private readonly storageKey: string,
        private readonly events?: SyncOutboxEvents,
        private readonly maxSize: number = 1000,
        private readonly now: () => number = () => Date.now(),
        private readonly inFlightTimeoutMs: number = 30_000
    ) {
        this.initialized = this.restore()
    }

    async enqueue(items: SyncOutboxItem[]) {
        await this.initialized
        let changed = false
        for (const item of items) {
            if (this.byKey.has(item.idempotencyKey)) continue
            if (this.queue.length >= this.maxSize) {
                const dropped = this.queue.shift()
                if (dropped) {
                    this.byKey.delete(dropped.idempotencyKey)
                    this.events?.onQueueFull?.(dropped, this.maxSize)
                }
            }
            const stored = { ...item, inFlightAtMs: undefined }
            this.queue.push(stored)
            this.byKey.set(item.idempotencyKey, stored)
            changed = true
        }
        if (changed) await this.persist()
    }

    async peek(limit: number) {
        await this.initialized
        if (!Number.isFinite(limit) || limit <= 0) return []
        const out: SyncOutboxItem[] = []
        const cap = Math.floor(limit)
        for (const item of this.queue) {
            if (out.length >= cap) break
            if (typeof item.inFlightAtMs === 'number') continue
            out.push(item)
        }
        return out
    }

    async ack(idempotencyKeys: string[]) {
        await this.removeByKeys(idempotencyKeys)
    }

    async reject(idempotencyKeys: string[]) {
        await this.removeByKeys(idempotencyKeys)
    }

    async markInFlight(idempotencyKeys: string[], atMs: number) {
        await this.initialized
        if (!idempotencyKeys.length) return
        const set = new Set(idempotencyKeys)
        let changed = false
        for (const item of this.queue) {
            if (!set.has(item.idempotencyKey)) continue
            if (typeof item.inFlightAtMs === 'number') continue
            item.inFlightAtMs = atMs
            changed = true
        }
        if (changed) await this.persist()
    }

    async releaseInFlight(idempotencyKeys: string[]) {
        await this.initialized
        if (!idempotencyKeys.length) return
        const set = new Set(idempotencyKeys)
        let changed = false
        for (const item of this.queue) {
            if (!set.has(item.idempotencyKey)) continue
            if (item.inFlightAtMs === undefined) continue
            item.inFlightAtMs = undefined
            changed = true
        }
        if (changed) await this.persist()
    }

    async size() {
        await this.initialized
        return this.queue.length
    }

    private async removeByKeys(keys: string[]) {
        await this.initialized
        if (!keys.length) return
        const set = new Set(keys)
        const next = this.queue.filter(item => !set.has(item.idempotencyKey))
        if (next.length === this.queue.length) return
        this.queue = next
        this.byKey = new Map(next.map(item => [item.idempotencyKey, item]))
        await this.persist()
    }

    private async persist() {
        await this.kv.set(this.storageKey, this.queue)
        this.events?.onQueueChange?.(this.queue.length)
    }

    private async restore() {
        const stored = await this.kv.get<any>(this.storageKey)
        if (Array.isArray(stored)) {
            this.queue = stored as Array<SyncOutboxItem & { inFlightAtMs?: number }>
            this.byKey = new Map(this.queue.map(item => [item.idempotencyKey, item]))
            await this.recoverStaleInFlight()
        }
    }

    private async recoverStaleInFlight() {
        const now = this.now()
        const timeout = Math.max(0, Math.floor(this.inFlightTimeoutMs))
        if (!timeout) return
        let changed = false
        for (const item of this.queue) {
            if (typeof item.inFlightAtMs !== 'number') continue
            if (item.inFlightAtMs + timeout <= now) {
                item.inFlightAtMs = undefined
                changed = true
            }
        }
        if (changed) await this.persist()
    }
}

export class VNextCursorStore implements CursorStore {
    private readonly kv = createKVStore()
    private cursor: Cursor | undefined
    private initialized: Promise<void>

    constructor(
        private readonly storageKey: string,
        private readonly initial?: Cursor
    ) {
        this.initialized = this.restore()
    }

    async get() {
        await this.initialized
        return this.cursor ?? this.initial
    }

    async set(next: Cursor) {
        await this.initialized
        if (this.cursor === undefined) {
            this.cursor = next
            await this.persist()
            return true
        }
        const cmp = defaultCompareCursor(this.cursor, next)
        if (cmp < 0) {
            this.cursor = next
            await this.persist()
            return true
        }
        return false
    }

    private async persist() {
        await this.kv.set(this.storageKey, this.cursor)
    }

    private async restore() {
        const stored = await this.kv.get<any>(this.storageKey)
        if (typeof stored === 'string' && stored) {
            this.cursor = stored
        }
    }
}
