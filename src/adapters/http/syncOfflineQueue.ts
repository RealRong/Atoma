import type { Patch } from 'immer'
import type { StoreKey } from '../../core/types'
import { createKVStore } from './kvStore'

const kv = createKVStore()

export type SyncQueuedOperation =
    | {
        idempotencyKey: string
        resource: string
        kind: 'create'
        id?: StoreKey
        timestamp: number
        data: any
        retryCount?: number
    }
    | {
        idempotencyKey: string
        resource: string
        kind: 'patch'
        id: StoreKey
        baseVersion: number
        timestamp: number
        patches: Patch[]
        retryCount?: number
    }
    | {
        idempotencyKey: string
        resource: string
        kind: 'delete'
        id: StoreKey
        baseVersion: number
        timestamp: number
        retryCount?: number
    }

export type SyncQueueEvents = {
    onQueueChange?: (size: number) => void
    onQueueFull?: (droppedOp: SyncQueuedOperation, maxSize: number) => void
}

function isSameEntity(a: SyncQueuedOperation, b: SyncQueuedOperation): boolean {
    const aid = (a as any).id
    const bid = (b as any).id
    if (aid === undefined || bid === undefined) return false
    return a.resource === b.resource && aid === bid
}

function stripIdPrefix(patches: Patch[], id: StoreKey) {
    return patches.map(p => {
        const path = Array.isArray((p as any).path) ? (p as any).path as any[] : []
        if (!path.length) return p
        const [head, ...rest] = path
        // 宽松比较兼容字符串/数字 id
        if (head == id) {
            return { ...p, path: rest } as any
        }
        return p
    })
}

export class SyncOfflineQueue {
    private queue: SyncQueuedOperation[] = []
    private initialized: Promise<void>
    private maxSize: number

    constructor(
        private storageKey: string,
        private events?: SyncQueueEvents,
        maxSize: number = 1000
    ) {
        this.maxSize = maxSize
        this.initialized = this.restore()
    }

    async waitForReady(): Promise<void> {
        return this.initialized
    }

    snapshot(): SyncQueuedOperation[] {
        return [...this.queue]
    }

    size(): number {
        return this.queue.length
    }

    keysWithPending(): Set<string> {
        const out = new Set<string>()
        for (const op of this.queue) {
            const id = (op as any).id
            if (id === undefined) continue
            out.add(`${op.resource}:${String(id)}`)
        }
        return out
    }

    async clear(): Promise<void> {
        await this.initialized
        this.queue = []
        await this.persist()
        this.events?.onQueueChange?.(0)
    }

    async enqueue(op: SyncQueuedOperation): Promise<void> {
        await this.initialized

        // 合并：尽量把同实体的多次操作压缩成单条（降低 /sync/push payload）
        const lastIndex = (() => {
            for (let i = this.queue.length - 1; i >= 0; i--) {
                if (isSameEntity(this.queue[i], op)) return i
            }
            return -1
        })()

        const existing = lastIndex >= 0 ? this.queue[lastIndex] : undefined
        if (existing) {
            // create + patch => 合并到 create（把 patch 应用到 data）
            if (existing.kind === 'create' && op.kind === 'patch') {
                const base = existing.data
                const normalized = stripIdPrefix(op.patches, op.id)
                // 避免引入 immer 依赖：patches 本身就是 immer patch，直接走 runtime apply 会更好；
                // 这里先保守：把 patch 追加到 create 的 data 末端由服务端处理不可行，因此必须本地应用。
                // 由于 HTTPAdapter 内部已使用 immer，这里直接动态 import 以避免循环依赖。
                const { applyPatches } = await import('immer')
                const next = applyPatches(base, normalized as any)
                this.queue[lastIndex] = { ...existing, data: next, timestamp: op.timestamp }
                await this.persist()
                this.events?.onQueueChange?.(this.queue.length)
                return
            }

            // create + delete => 直接抵消（本地创建后又删掉，不需要上行）
            if (existing.kind === 'create' && op.kind === 'delete') {
                this.queue.splice(lastIndex, 1)
                await this.persist()
                this.events?.onQueueChange?.(this.queue.length)
                return
            }

            // patch + patch => 合并 patches，baseVersion 保持最早的那次
            if (existing.kind === 'patch' && op.kind === 'patch') {
                this.queue[lastIndex] = {
                    ...existing,
                    patches: [...existing.patches, ...op.patches],
                    timestamp: op.timestamp
                }
                await this.persist()
                this.events?.onQueueChange?.(this.queue.length)
                return
            }

            // patch + delete => delete 覆盖 patch（以最后一次为准）
            if (existing.kind === 'patch' && op.kind === 'delete') {
                this.queue[lastIndex] = op
                await this.persist()
                this.events?.onQueueChange?.(this.queue.length)
                return
            }

            // delete + create => 视为重建（保留 create）
            if (existing.kind === 'delete' && op.kind === 'create') {
                this.queue[lastIndex] = op
                await this.persist()
                this.events?.onQueueChange?.(this.queue.length)
                return
            }
        }

        if (this.queue.length >= this.maxSize) {
            const dropped = this.queue.shift()
            if (dropped) {
                this.events?.onQueueFull?.(dropped, this.maxSize)
            }
        }

        this.queue.push(op)
        await this.persist()
        this.events?.onQueueChange?.(this.queue.length)
    }

    async removeByIdempotencyKeys(keys: Set<string>): Promise<void> {
        await this.initialized
        if (!keys.size) return
        const next = this.queue.filter(op => !keys.has(op.idempotencyKey))
        this.queue = next
        await this.persist()
        this.events?.onQueueChange?.(this.queue.length)
    }

    private async persist() {
        try {
            await kv.set(this.storageKey, this.queue)
        } catch (error) {
            console.error('Failed to persist sync offline queue:', error)
        }
    }

    private async restore() {
        try {
            const stored = await kv.get<SyncQueuedOperation[]>(this.storageKey)
            if (stored && Array.isArray(stored)) {
                this.queue = stored
                this.events?.onQueueChange?.(this.queue.length)
            }
        } catch (error) {
            console.error('Failed to restore sync offline queue:', error)
            this.queue = []
        }
    }
}

