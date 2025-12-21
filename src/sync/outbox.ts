import type { OutboxStore, SyncOutboxItem } from './types'

export class MemoryOutboxStore implements OutboxStore {
    private readonly items: SyncOutboxItem[] = []
    private readonly byKey = new Map<string, SyncOutboxItem>()

    enqueue(items: SyncOutboxItem[]) {
        for (const item of items) {
            if (this.byKey.has(item.idempotencyKey)) continue
            this.byKey.set(item.idempotencyKey, item)
            this.items.push(item)
        }
    }

    peek(limit: number) {
        if (!Number.isFinite(limit) || limit <= 0) return []
        return this.items.slice(0, Math.floor(limit))
    }

    ack(idempotencyKeys: string[]) {
        this.removeByKeys(idempotencyKeys)
    }

    reject(idempotencyKeys: string[]) {
        this.removeByKeys(idempotencyKeys)
    }

    size() {
        return this.items.length
    }

    private removeByKeys(keys: string[]) {
        if (!keys.length) return
        const toRemove = new Set(keys)
        this.items.splice(0, this.items.length, ...this.items.filter(item => !toRemove.has(item.idempotencyKey)))
        keys.forEach(key => this.byKey.delete(key))
    }
}
