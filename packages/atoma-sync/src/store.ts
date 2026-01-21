import { createKVStore } from './kvStore'
import type { CursorStore, OutboxStore, SyncOutboxItem, SyncOutboxEvents } from './types'
import { defaultCompareCursor } from './policies/cursorGuard'
import { Protocol, type Cursor, type Operation, type WriteAction, type WriteItem, type WriteOptions } from 'atoma/protocol'
import type { OutboxQueueMode } from './types'
import { assertOutboxItemValid } from './outboxSpec'

export type SyncStoresConfig = {
    outboxKey: string
    cursorKey: string
    queueEnabled?: boolean
    queueMode?: OutboxQueueMode
    maxQueueSize?: number
    outboxEvents?: SyncOutboxEvents
    now?: () => number
    inFlightTimeoutMs?: number
}

export type SyncStores = {
    outbox?: OutboxStore
    cursor: CursorStore
}

export function createStores(config: SyncStoresConfig): SyncStores {
    const queueEnabled = config.queueEnabled !== false
    return {
        outbox: queueEnabled
            ? new DefaultOutboxStore(
                config.outboxKey,
                config.outboxEvents,
                config.maxQueueSize ?? 1000,
                config.now ?? (() => Date.now()),
                config.inFlightTimeoutMs ?? 30_000,
                config.queueMode
            )
            : undefined,
        cursor: new DefaultCursorStore(config.cursorKey)
    }
}

export class DefaultOutboxStore implements OutboxStore {
    private readonly kv = createKVStore()
    private queue: Array<SyncOutboxItem & { inFlightAtMs?: number }> = []
    private byKey = new Map<string, SyncOutboxItem & { inFlightAtMs?: number }>()
    private initialized: Promise<void>
    readonly queueMode: OutboxQueueMode

    constructor(
        private readonly storageKey: string,
        private events?: SyncOutboxEvents,
        private readonly maxQueueSize: number = 1000,
        private readonly now: () => number = () => Date.now(),
        private readonly inFlightTimeoutMs: number = 30_000,
        queueMode: OutboxQueueMode = 'queue'
    ) {
        this.queueMode = queueMode === 'local-first' ? 'local-first' : 'queue'
        this.initialized = this.restore()
    }

    setEvents(events?: SyncOutboxEvents) {
        this.events = events
    }

    async enqueue(items: SyncOutboxItem[]) {
        await this.initialized
        let changed = false
        for (const item of items) {
            if (this.byKey.has(item.idempotencyKey)) continue
            if (this.queue.length >= this.maxQueueSize) {
                const dropped = this.queue.shift()
                if (dropped) {
                    this.byKey.delete(dropped.idempotencyKey)
                    this.events?.onQueueFull?.(dropped, this.maxQueueSize)
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

    async rebase(args: { resource: string; entityId: string; baseVersion: number; afterEnqueuedAtMs?: number }) {
        await this.initialized
        const nextBaseVersion = args.baseVersion
        if (!(typeof nextBaseVersion === 'number' && Number.isFinite(nextBaseVersion) && nextBaseVersion > 0)) return

        const resource = String(args.resource || '')
        const entityId = String(args.entityId || '')
        const afterEnqueuedAtMs = typeof args.afterEnqueuedAtMs === 'number' && Number.isFinite(args.afterEnqueuedAtMs)
            ? args.afterEnqueuedAtMs
            : undefined

        if (!resource || !entityId) return

        let changed = false

        for (const item of this.queue) {
            if (typeof item.inFlightAtMs === 'number') continue
            if (afterEnqueuedAtMs !== undefined && item.enqueuedAtMs <= afterEnqueuedAtMs) continue

            const op: any = (item as any).op
            if (!op || op.kind !== 'write') continue

            const write: any = op.write
            if (!write || write.resource !== resource) continue

            const opItem: any = write?.items?.[0]
            const curEntityId = opItem?.entityId
            if (typeof curEntityId !== 'string' || curEntityId !== entityId) continue

            if (opItem && typeof opItem === 'object') {
                if (typeof opItem.baseVersion === 'number' && Number.isFinite(opItem.baseVersion) && opItem.baseVersion > 0) {
                    if (opItem.baseVersion === nextBaseVersion) continue
                    if (opItem.baseVersion < nextBaseVersion) {
                        opItem.baseVersion = nextBaseVersion
                        changed = true
                    }
                }
            }
        }

        if (changed) await this.persist()
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

    async enqueueOps(args: { ops: Operation[] }) {
        const now = this.now()
        const items: SyncOutboxItem[] = []

        for (const op of args.ops) {
            if (!op || (op as any).kind !== 'write') {
                throw new Error('[Sync] enqueueOps only supports write ops')
            }

            const write = (op as any).write as any
            const resource = String(write?.resource ?? '')
            const action = write?.action as WriteAction
            const options = (write?.options && typeof write.options === 'object') ? (write.options as WriteOptions) : undefined
            const opItems: WriteItem[] = Array.isArray(write?.items) ? (write.items as WriteItem[]) : []
            if (!resource || !action || opItems.length !== 1) {
                throw new Error('[Sync] enqueueOps requires single-item write ops')
            }

            const baseItem = opItems[0] as WriteItem
            const meta = this.requireItemMeta(baseItem)
            const ensuredItem = { ...(baseItem as any), meta } as WriteItem

            const ensuredOp: Operation = Protocol.ops.build.buildWriteOp({
                opId: String((op as any).opId || this.nextOpId('w')),
                write: {
                    resource,
                    action,
                    items: [ensuredItem],
                    ...(options ? { options } : {})
                }
            })

            const entry = {
                idempotencyKey: meta.idempotencyKey!,
                op: ensuredOp,
                enqueuedAtMs: now
            } as SyncOutboxItem
            assertOutboxItemValid(entry)
            items.push(entry)
        }

        await this.enqueue(items)
        return items.map(i => i.idempotencyKey)
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

    private requireItemMeta(item: WriteItem) {
        const meta = (item as any)?.meta
        if (!meta || typeof meta !== 'object') {
            throw new Error('[Sync] write item meta is required for enqueueOps')
        }
        if (typeof (meta as any).idempotencyKey !== 'string' || !(meta as any).idempotencyKey) {
            throw new Error('[Sync] write item meta.idempotencyKey is required for enqueueOps')
        }
        if (typeof (meta as any).clientTimeMs !== 'number' || !Number.isFinite((meta as any).clientTimeMs)) {
            throw new Error('[Sync] write item meta.clientTimeMs is required for enqueueOps')
        }
        return meta as any
    }

    private nextOpId(prefix: 'w' | 'c') {
        return Protocol.ids.createOpId(prefix, { now: () => this.now() })
    }
}

export class DefaultCursorStore implements CursorStore {
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
