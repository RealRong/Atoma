import { StoreKey } from '../../core/types'
import { createKVStore } from './kvStore'

const kv = createKVStore()

export interface QueuedOperation {
    id: string
    type: 'put' | 'delete'
    key?: StoreKey
    value?: any
    timestamp: number
    retryCount?: number
}

export interface QueueEvents {
    onQueueChange?: (size: number) => void
    onSyncStart?: (pending: number) => void
    onSyncComplete?: (remaining: number) => void
    onSyncError?: (error: Error, op: QueuedOperation) => void
    onQueueFull?: (droppedOp: QueuedOperation, queueSize: number) => void
}

export class OfflineQueue {
    private queue: QueuedOperation[] = []
    private storageKey: string
    private initialized: Promise<void>
    private maxSize: number

    constructor(storageKey: string, private events?: QueueEvents, maxSize: number = 100) {
        this.storageKey = storageKey
        this.maxSize = maxSize
        this.initialized = this.restore()
    }

    async enqueue(op: QueuedOperation) {
        await this.initialized
        const existingIndex = this.findLastIndexByKey(op.key)
        const existing = existingIndex >= 0 ? this.queue[existingIndex] : undefined

        if (existing) {
            // PUT + PUT -> keep latest value
            if (existing.type === 'put' && op.type === 'put') {
                this.queue[existingIndex] = { ...existing, value: op.value, timestamp: op.timestamp }
                await this.persist()
                this.events?.onQueueChange?.(this.queue.length)
                return
            }

            // DELETE + DELETE -> update timestamp only
            if (existing.type === 'delete' && op.type === 'delete') {
                this.queue[existingIndex] = { ...existing, timestamp: op.timestamp }
                await this.persist()
                this.events?.onQueueChange?.(this.queue.length)
                return
            }

            // PUT + DELETE -> delete wins
            if (existing.type === 'put' && op.type === 'delete') {
                this.queue[existingIndex] = { ...op }
                await this.persist()
                this.events?.onQueueChange?.(this.queue.length)
                return
            }

            // DELETE + PUT -> recreation/update, replace with put
            if (existing.type === 'delete' && op.type === 'put') {
                this.queue[existingIndex] = { ...op }
                await this.persist()
                this.events?.onQueueChange?.(this.queue.length)
                return
            }
        } else {
            // Check queue size limit before adding new operation
            if (this.queue.length >= this.maxSize) {
                // FIFO eviction: remove oldest operation
                const dropped = this.queue.shift()
                if (dropped) {
                    this.events?.onQueueFull?.(dropped, this.maxSize)
                    console.warn(`Offline queue full (max: ${this.maxSize}). Dropped oldest operation:`, {
                        type: dropped.type,
                        key: dropped.key,
                        timestamp: dropped.timestamp
                    })
                }
            }
            this.queue.push(op)
        }

        await this.persist()
        this.events?.onQueueChange?.(this.queue.length)
    }

    snapshot(): QueuedOperation[] {
        // Snapshot is synchronous for immediate access, 
        // assuming queue is in memory after restore()
        return [...this.queue]
    }

    async clear() {
        await this.initialized
        this.queue = []
        await this.persist()
        this.events?.onQueueChange?.(0)
    }

    size(): number {
        return this.queue.length
    }

    async shift(): Promise<QueuedOperation | undefined> {
        await this.initialized
        const op = this.queue.shift()
        await this.persist()
        this.events?.onQueueChange?.(this.queue.length)
        return op
    }

    async waitForReady(): Promise<void> {
        return this.initialized
    }

    private async persist() {
        try {
            await kv.set(this.storageKey, this.queue)
        } catch (error) {
            console.error('Failed to persist offline queue:', error)
        }
    }

    private async restore() {
        try {
            const stored = await kv.get<QueuedOperation[]>(this.storageKey)
            if (stored && Array.isArray(stored)) {
                this.queue = stored
                this.events?.onQueueChange?.(this.queue.length)
            }
        } catch (error) {
            console.error('Failed to restore offline queue:', error)
            this.queue = []
        }
    }

    private findLastIndexByKey(key?: StoreKey): number {
        if (key === undefined) return -1
        for (let i = this.queue.length - 1; i >= 0; i--) {
            if (this.queue[i].key === key) return i
        }
        return -1
    }
}
