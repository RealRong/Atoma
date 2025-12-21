import { createKVStore } from './kvStore'
import type { OutboxStore, CursorStore, SyncOutboxItem } from '../../sync'
import { defaultCompareCursor } from '../../sync'
import type { VNextCursor, VNextWriteAction, VNextWriteItem } from '#protocol'

const kv = createKVStore()

export type VNextOutboxEvents = {
    onQueueChange?: (size: number) => void
    onQueueFull?: (droppedOp: SyncOutboxItem, maxSize: number) => void
}

export class VNextOutboxStore implements OutboxStore {
    private queue: SyncOutboxItem[] = []
    private byKey = new Map<string, SyncOutboxItem>()
    private initialized: Promise<void>

    constructor(
        private readonly storageKey: string,
        private readonly events?: VNextOutboxEvents,
        private readonly maxSize: number = 1000
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
            this.queue.push(item)
            this.byKey.set(item.idempotencyKey, item)
            changed = true
        }
        if (changed) await this.persist()
    }

    async peek(limit: number) {
        await this.initialized
        if (!Number.isFinite(limit) || limit <= 0) return []
        return this.queue.slice(0, Math.floor(limit))
    }

    async ack(idempotencyKeys: string[]) {
        await this.removeByKeys(idempotencyKeys)
    }

    async reject(idempotencyKeys: string[]) {
        await this.removeByKeys(idempotencyKeys)
    }

    async size() {
        await this.initialized
        return this.queue.length
    }

    keysWithPending(): Set<string> {
        const out = new Set<string>()
        for (const item of this.queue) {
            const id = readEntityId(item.action, item.item)
            if (id === undefined || id === null) continue
            out.add(`${item.resource}:${String(id)}`)
        }
        return out
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
        try {
            await kv.set(this.storageKey, this.queue)
        } catch {
            // ignore persistence failures
        }
        this.events?.onQueueChange?.(this.queue.length)
    }

    private async restore() {
        try {
            const stored = await kv.get<any>(this.storageKey)
            if (Array.isArray(stored)) {
                this.queue = stored as SyncOutboxItem[]
                this.byKey = new Map(this.queue.map(item => [item.idempotencyKey, item]))
            }
        } catch {
            // ignore restore failures
        }
    }
}

export class VNextCursorStore implements CursorStore {
    private cursor: VNextCursor | undefined
    private initialized: Promise<void>

    constructor(
        private readonly storageKey: string,
        private readonly initial?: VNextCursor
    ) {
        this.initialized = this.restore()
    }

    async get() {
        await this.initialized
        return this.cursor ?? this.initial
    }

    async set(next: VNextCursor) {
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
        try {
            await kv.set(this.storageKey, this.cursor)
        } catch {
            // ignore
        }
    }

    private async restore() {
        try {
            const stored = await kv.get<any>(this.storageKey)
            if (typeof stored === 'string' && stored) {
                this.cursor = stored
            }
        } catch {
            // ignore
        }
    }
}

function readEntityId(action: VNextWriteAction, item: VNextWriteItem) {
    if (action === 'create') {
        const value = (item as any).value
        const entityId = (item as any).entityId
        if (entityId !== undefined) return entityId
        if (value && typeof value === 'object') return (value as any).id
        return undefined
    }
    if (action === 'update' || action === 'patch' || action === 'delete') {
        return (item as any).entityId
    }
    return undefined
}
