import type {
    SyncEngineConfig,
    SyncOutboxItem,
    SyncWriteAck,
    SyncWriteReject
} from './types'
import type { VNextMeta, VNextWriteAction, VNextWriteItem, VNextWriteItemResult } from '#protocol'

export class SyncEngine {
    private disposed = false
    private started = false
    private pushing = false
    private pulling = false
    private flushScheduled = false
    private flushRequested = false
    private subscription?: { close: () => void }
    private reconnectTimer?: ReturnType<typeof setTimeout>
    private opSeq = 0

    constructor(private readonly config: SyncEngineConfig) {}

    start() {
        if (this.disposed) return
        this.started = true
        if (this.config.subscribe) {
            this.openSubscribe()
        }
    }

    stop() {
        this.started = false
        this.closeSubscribe()
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = undefined
        }
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.stop()
    }

    async enqueueWrite(args: {
        resource: string
        action: VNextWriteAction
        items: VNextWriteItem[]
    }) {
        if (this.disposed) throw new Error('SyncEngine disposed')
        const now = this.now()
        const items: SyncOutboxItem[] = args.items.map(item => {
            const meta = this.ensureItemMeta(item)
            return {
                idempotencyKey: meta.idempotencyKey!,
                resource: args.resource,
                action: args.action,
                item: { ...item, meta },
                enqueuedAtMs: now
            }
        })
        await this.config.outbox.enqueue(items)
        this.scheduleFlush()
        return items.map(i => i.idempotencyKey)
    }

    async flush() {
        if (this.disposed) throw new Error('SyncEngine disposed')
        if (this.pushing) {
            this.flushRequested = true
            return
        }

        this.pushing = true
        this.config.onStateChange?.('pushing')
        try {
            while (!this.disposed) {
                const batch = await this.peekWriteBatch()
                if (!batch.items.length) break

                const { resource, action, items, entries } = batch
                const opId = this.nextOpId('w')
                const meta = this.buildMeta()

                try {
                    const result = await this.config.transport.push({
                        opId,
                        resource,
                        action,
                        items,
                        options: { returning: this.config.returning !== false },
                        meta
                    })

                    const mapped = indexWriteResults(result.results)
                    const acked: string[] = []
                    const rejected: string[] = []

                    for (let i = 0; i < entries.length; i++) {
                        const outboxItem = entries[i]
                        const res = mapped.get(i)
                        if (res && res.ok === true) {
                            const ack: SyncWriteAck = {
                                resource,
                                action,
                                item: outboxItem.item,
                                result: res
                            }
                            await Promise.resolve(this.config.applier.applyWriteAck(ack))
                            acked.push(outboxItem.idempotencyKey)
                            continue
                        }

                        const rejectRes = (res && res.ok === false)
                            ? res
                            : {
                                index: i,
                                ok: false as const,
                                error: { code: 'WRITE_FAILED', message: 'Missing write item result' }
                            }
                        const reject: SyncWriteReject = {
                            resource,
                            action,
                            item: outboxItem.item,
                            result: rejectRes
                        }
                        await Promise.resolve(this.config.applier.applyWriteReject(reject))
                        rejected.push(outboxItem.idempotencyKey)
                    }

                    await this.config.outbox.ack(acked)
                    await this.config.outbox.reject(rejected)
                } catch (error) {
                    this.config.onError?.(toError(error), { phase: 'push' })
                    break
                }
            }
        } finally {
            this.pushing = false
            this.config.onStateChange?.('idle')
            if (this.flushRequested) {
                this.flushRequested = false
                this.scheduleFlush(true)
            }
        }
    }

    async pullNow() {
        if (this.disposed) throw new Error('SyncEngine disposed')
        if (this.pulling) return
        this.pulling = true
        this.config.onStateChange?.('pulling')
        try {
            const cursor = await this.readCursor()
            const limit = Math.max(1, Math.floor(this.config.pullLimit ?? 200))
            const meta = this.buildMeta()
            const opId = this.nextOpId('c')
            const batch = await this.config.transport.pull({
                opId,
                cursor,
                limit,
                resources: this.config.resources,
                meta
            })

            if (batch.changes.length) {
                await Promise.resolve(this.config.applier.applyChanges(batch.changes))
            }
            await this.config.cursor.set(batch.nextCursor)
            return batch
        } catch (error) {
            this.config.onError?.(toError(error), { phase: 'pull' })
            throw error
        } finally {
            this.pulling = false
            this.config.onStateChange?.('idle')
        }
    }

    setSubscribed(enabled: boolean) {
        if (enabled) {
            this.config.onStateChange?.('subscribed')
            this.openSubscribe()
            return
        }
        this.closeSubscribe()
    }

    private scheduleFlush(immediate = false) {
        if (this.disposed) return
        if (this.flushScheduled) return
        this.flushScheduled = true
        const trigger = () => {
            this.flushScheduled = false
            void this.flush()
        }
        if (immediate) {
            queueMicrotask(trigger)
            return
        }
        queueMicrotask(trigger)
    }

    private async peekWriteBatch() {
        const max = Math.max(1, Math.floor(this.config.maxPushItems ?? 50))
        const pending = await this.config.outbox.peek(max)
        if (!pending.length) {
            return { resource: '', action: 'create' as VNextWriteAction, items: [] as VNextWriteItem[], entries: [] as SyncOutboxItem[] }
        }

        const first = pending[0]
        const items: SyncOutboxItem[] = []
        for (const item of pending) {
            if (item.resource !== first.resource || item.action !== first.action) break
            items.push(item)
        }

        return {
            resource: first.resource,
            action: first.action,
            items: items.map(i => i.item),
            entries: items
        }
    }

    private openSubscribe() {
        if (this.disposed || !this.started || !this.config.subscribe) return
        if (this.subscription) return

        void (async () => {
            try {
                const cursor = await this.readCursor()
                this.subscription = this.config.transport.subscribe({
                    cursor,
                    onBatch: async (batch) => {
                        try {
                            if (batch.changes.length) {
                                await Promise.resolve(this.config.applier.applyChanges(batch.changes))
                            }
                            await this.config.cursor.set(batch.nextCursor)
                        } catch (error) {
                            this.config.onError?.(toError(error), { phase: 'subscribe' })
                        }
                    },
                    onError: (error) => {
                        this.config.onError?.(toError(error), { phase: 'subscribe' })
                        this.closeSubscribe()
                        this.scheduleReconnect()
                    }
                })
                this.config.onStateChange?.('subscribed')
            } catch (error) {
                this.config.onError?.(toError(error), { phase: 'subscribe' })
                this.scheduleReconnect()
            }
        })()
    }

    private closeSubscribe() {
        if (this.subscription) {
            try {
                this.subscription.close()
            } catch {
                // ignore
            }
            this.subscription = undefined
        }
    }

    private scheduleReconnect() {
        if (!this.started || !this.config.subscribe) return
        if (this.reconnectTimer) return
        this.config.onStateChange?.('backoff')
        const delay = Math.max(0, Math.floor(this.config.reconnectDelayMs ?? 1000))
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined
            this.openSubscribe()
        }, delay)
    }

    private ensureItemMeta(item: VNextWriteItem) {
        const meta = (item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)) ? item.meta : {}
        const idempotencyKey = typeof meta.idempotencyKey === 'string' && meta.idempotencyKey
            ? meta.idempotencyKey
            : this.createIdempotencyKey()
        return {
            ...meta,
            idempotencyKey
        }
    }

    private buildMeta(): VNextMeta {
        return {
            v: 1,
            clientTimeMs: this.now()
        }
    }

    private now() {
        return this.config.now ? this.config.now() : Date.now()
    }

    private async readCursor() {
        const cur = await this.config.cursor.get()
        if (cur !== undefined && cur !== null && cur !== '') return cur
        return this.config.initialCursor ?? '0'
    }

    private createIdempotencyKey(): string {
        if (typeof crypto !== 'undefined') {
            const randomUUID = Reflect.get(crypto, 'randomUUID')
            if (typeof randomUUID === 'function') {
                const uuid = randomUUID.call(crypto)
                if (typeof uuid === 'string' && uuid) return `s_${uuid}`
            }
        }
        this.opSeq += 1
        return `s_${Date.now()}_${this.opSeq}`
    }

    private nextOpId(prefix: 'w' | 'c') {
        this.opSeq += 1
        return `${prefix}_${Date.now()}_${this.opSeq}`
    }
}

function indexWriteResults(results: VNextWriteItemResult[]) {
    const map = new Map<number, VNextWriteItemResult>()
    for (const res of results) {
        if (typeof res.index === 'number' && Number.isFinite(res.index)) {
            map.set(res.index, res)
        }
    }
    return map
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
}
