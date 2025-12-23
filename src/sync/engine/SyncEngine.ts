import type { SyncClient, SyncConfig, SyncOutboxItem } from '../types'
import { createApplier } from '../internal'
import { PushLane } from '../lanes/PushLane'
import { PullLane } from '../lanes/PullLane'
import { SubscribeLane, subscribeToVNextChangesSse } from '../lanes/SubscribeLane'
import { createIdempotencyKey, createOpId, type IdSequence } from '../policies/idempotency'
import { createVNextStores } from '../vnextStore'
import type { Cursor, Meta, WriteAction, WriteItem } from '#protocol'
import { computeBackoffDelayMs } from '../policies/backoffPolicy'
import { SingleInstanceLock } from '../policies/singleInstanceLock'
import type { SyncTransport } from '../types'

export class SyncEngine implements SyncClient {
    private disposed = false
    private started = false
    private readonly seq: IdSequence = { value: 0 }

    private readonly resolved: {
        maxPushItems: number
        pullLimit: number
        resources?: string[]
        initialCursor?: Cursor
        returning: boolean
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
        subscribe: boolean
        reconnectDelayMs: number
        periodicPullIntervalMs: number
        retry: { maxAttempts?: number }
        pushBackoff: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
        subscribeBackoff: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
        periodicPullBackoff: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
        lockBackoff: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
    }

    private readonly outbox
    private readonly cursor
    private readonly applier

    private readonly pushLane: PushLane
    private readonly pullLane: PullLane
    private readonly subscribeLane: SubscribeLane
    private periodicPullTimer?: ReturnType<typeof setTimeout>
    private periodicPullAttempt = 0
    private lock?: SingleInstanceLock
    private startInFlight?: Promise<void>
    private readonly transport: SyncTransport

    constructor(private readonly config: SyncConfig) {
        const resolveBackoff = (fallback: { baseDelayMs: number }) => {
            return {
                baseDelayMs: fallback.baseDelayMs,
                maxDelayMs: 30_000,
                jitterRatio: 0.2,
                ...(config.backoff ?? {})
            }
        }

        const reconnectDelayMs = Math.max(0, Math.floor(config.reconnectDelayMs ?? 1000))
        const periodicPullIntervalMs = Math.max(0, Math.floor(config.periodicPullIntervalMs ?? 5_000))

        this.resolved = {
            maxPushItems: Math.max(1, Math.floor(config.maxPushItems ?? 50)),
            pullLimit: Math.max(1, Math.floor(config.pullLimit ?? 200)),
            resources: config.resources,
            initialCursor: config.initialCursor,
            returning: config.returning !== false,
            conflictStrategy: config.conflictStrategy,
            subscribe: config.subscribe === true,
            reconnectDelayMs,
            periodicPullIntervalMs,
            retry: config.retry ?? { maxAttempts: 10 },
            pushBackoff: resolveBackoff({ baseDelayMs: 300 }),
            subscribeBackoff: resolveBackoff({ baseDelayMs: reconnectDelayMs }),
            periodicPullBackoff: resolveBackoff({ baseDelayMs: Math.max(0, Math.floor(config.periodicPullIntervalMs ?? 1_000)) }),
            lockBackoff: resolveBackoff({ baseDelayMs: Math.max(0, Math.floor(config.reconnectDelayMs ?? 300)) })
        }

        this.transport = {
            executeOps: config.executeOps,
            subscribe: (args) => {
                if (!config.subscribeUrl) {
                    throw new Error('[Sync] subscribeUrl is required when subscribe is enabled')
                }
                return subscribeToVNextChangesSse({
                    cursor: args.cursor,
                    buildUrl: config.subscribeUrl,
                    eventSourceFactory: config.eventSourceFactory,
                    eventName: config.subscribeEventName,
                    onBatch: args.onBatch,
                    onError: args.onError
                })
            }
        }

        const stores = createVNextStores({
            outboxKey: config.outboxKey,
            cursorKey: config.cursorKey,
            maxQueueSize: config.maxQueueSize,
            outboxEvents: config.outboxEvents,
            now: () => this.now(),
            inFlightTimeoutMs: config.inFlightTimeoutMs ?? 30_000
        })

        this.outbox = stores.outbox
        this.cursor = stores.cursor
        this.applier = createApplier({
            defaultConflictStrategy: config.conflictStrategy,
            onPullChanges: config.onPullChanges,
            onWriteAck: config.onWriteAck,
            onWriteReject: config.onWriteReject
        })

        this.pushLane = new PushLane({
            outbox: this.outbox,
            transport: this.transport,
            applier: this.applier,
            maxPushItems: this.resolved.maxPushItems,
            returning: this.resolved.returning,
            conflictStrategy: this.resolved.conflictStrategy,
            retry: this.resolved.retry,
            backoff: this.resolved.pushBackoff,
            now: () => this.now(),
            buildMeta: () => this.buildMeta(),
            nextOpId: (prefix) => this.nextOpId(prefix),
            onError: config.onError,
            onEvent: config.onEvent
        })

        this.pullLane = new PullLane({
            cursor: this.cursor,
            transport: this.transport,
            applier: this.applier,
            pullLimit: this.resolved.pullLimit,
            resources: this.resolved.resources,
            initialCursor: this.resolved.initialCursor,
            buildMeta: () => this.buildMeta(),
            nextOpId: (prefix) => this.nextOpId(prefix),
            onError: config.onError,
            onEvent: config.onEvent
        })

        this.subscribeLane = new SubscribeLane({
            cursor: this.cursor,
            transport: this.transport,
            applier: this.applier,
            initialCursor: this.resolved.initialCursor,
            reconnectDelayMs: this.resolved.reconnectDelayMs,
            retry: this.resolved.retry,
            backoff: this.resolved.subscribeBackoff,
            onError: config.onError,
            onEvent: config.onEvent
        })
    }

    start() {
        if (this.disposed) return
        this.started = true
        if (this.startInFlight) return
        this.config.onEvent?.({ type: 'lifecycle:starting' })
        this.startInFlight = this.startWithLock().finally(() => {
            this.startInFlight = undefined
        })
    }

    stop() {
        if (!this.started && !this.startInFlight && !this.lock) return
        this.started = false
        this.config.onEvent?.({ type: 'lifecycle:stopped' })
        this.subscribeLane.stop()
        this.clearPeriodicPull()
        void this.lock?.release().catch(() => {
            // ignore
        })
        this.lock = undefined
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.stop()
        this.pushLane.dispose()
        this.pullLane.dispose()
        this.subscribeLane.dispose()
    }

    async enqueueWrite(args: {
        resource: string
        action: WriteAction
        items: WriteItem[]
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
        await this.outbox.enqueue(items)
        this.pushLane.requestFlush()
        return items.map(i => i.idempotencyKey)
    }

    async flush() {
        if (this.disposed) throw new Error('SyncEngine disposed')
        await this.pushLane.flush()
    }

    async pullNow() {
        if (this.disposed) throw new Error('SyncEngine disposed')
        return this.pullLane.pullNow()
    }

    setSubscribed(enabled: boolean) {
        if (this.disposed) return
        this.subscribeLane.setEnabled(enabled)
    }

    private ensureItemMeta(item: WriteItem) {
        const meta = (item.meta && typeof item.meta === 'object' && !Array.isArray(item.meta)) ? item.meta : {}
        const idempotencyKey = typeof (meta as any).idempotencyKey === 'string' && (meta as any).idempotencyKey
            ? (meta as any).idempotencyKey
            : this.createIdempotencyKey()
        return {
            ...meta,
            idempotencyKey
        }
    }

    private buildMeta(): Meta {
        return {
            v: 1,
            clientTimeMs: this.now()
        }
    }

    private now() {
        return this.config.now ? this.config.now() : Date.now()
    }

    private lockKey() {
        return this.config.lockKey ?? `${this.config.outboxKey}:lock`
    }

    private async startWithLock() {
        const lockKey = this.lockKey()

        const lock = new SingleInstanceLock({
            key: lockKey,
            ttlMs: Math.max(1000, Math.floor(this.config.lockTtlMs ?? 10_000)),
            renewIntervalMs: Math.max(200, Math.floor(this.config.lockRenewIntervalMs ?? 3_000)),
            now: () => this.now(),
            maxAcquireAttempts: 5,
            backoff: this.resolved.lockBackoff,
            onLost: (error) => {
                this.config.onEvent?.({ type: 'lifecycle:lock_lost', error })
                this.config.onError?.(error, { phase: 'lifecycle' })
                this.stop()
            }
        })
        this.lock = lock

        try {
            await lock.acquire()
        } catch (error) {
            const err = toError(error)
            this.config.onEvent?.({ type: 'lifecycle:lock_failed', error: err })
            this.config.onError?.(err, { phase: 'lifecycle' })
            this.started = false
            this.lock = undefined
            return
        }

        if (this.disposed || !this.started) {
            void lock.release().catch(() => {
                // ignore
            })
            if (this.lock === lock) this.lock = undefined
            return
        }

        this.subscribeLane.start()
        this.subscribeLane.setEnabled(this.resolved.subscribe)
        this.pushLane.requestFlush(true)
        this.schedulePeriodicPull(0)
        this.config.onEvent?.({ type: 'lifecycle:started' })
    }

    private schedulePeriodicPull(delayMs: number) {
        if (this.disposed || !this.started) return
        this.clearPeriodicPull()
        const interval = this.resolved.periodicPullIntervalMs
        if (interval <= 0) return

        const delay = delayMs === 0 ? 0 : Math.max(0, Math.floor(delayMs))
        this.periodicPullTimer = setTimeout(() => {
            void this.runPeriodicPull()
        }, delay)
    }

    private clearPeriodicPull() {
        if (!this.periodicPullTimer) return
        clearTimeout(this.periodicPullTimer)
        this.periodicPullTimer = undefined
    }

    private async runPeriodicPull() {
        if (this.disposed || !this.started) return

        try {
            await this.pullLane.pullNow()
            this.periodicPullAttempt = 0
            this.schedulePeriodicPull(this.resolved.periodicPullIntervalMs)
        } catch (error) {
            this.periodicPullAttempt += 1
            const maxAttempts = this.resolved.retry.maxAttempts
            if (maxAttempts !== undefined && this.periodicPullAttempt >= Math.max(1, Math.floor(maxAttempts))) {
                return
            }
            const delay = computeBackoffDelayMs(this.periodicPullAttempt, this.resolved.periodicPullBackoff)
            this.config.onEvent?.({ type: 'pull:backoff', attempt: this.periodicPullAttempt, delayMs: delay })
            this.schedulePeriodicPull(delay)
        }
    }

    private createIdempotencyKey(): string {
        return createIdempotencyKey('s', this.seq, () => Date.now())
    }

    private nextOpId(prefix: 'w' | 'c') {
        return createOpId(prefix, this.seq, () => Date.now())
    }
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
}
