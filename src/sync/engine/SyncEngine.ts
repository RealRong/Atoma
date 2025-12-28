import type { SyncBackoffConfig, SyncClient, SyncConfig, SyncOutboxItem, SyncRetryConfig, SyncTransport } from '../types'
import { createApplier, toError } from '../internal'
import { PushLane } from '../lanes/PushLane'
import { PullLane } from '../lanes/PullLane'
import { SubscribeLane } from '../lanes/SubscribeLane'
import { createStores } from '../store'
import type { Cursor, Meta, WriteAction, WriteItem } from '#protocol'
import { Protocol } from '#protocol'
import { SingleInstanceLock } from '../policies/singleInstanceLock'
import { RetryBackoff } from '../policies/retryBackoff'

type ResolvedSyncConfig = {
    push: {
        maxItems: number
        returning: boolean
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
        retry: SyncRetryConfig
        backoff: SyncBackoffConfig
    }
    pull: {
        limit: number
        resources?: string[]
        initialCursor?: Cursor
        periodic: {
            intervalMs: number
            retry: SyncRetryConfig
            backoff: SyncBackoffConfig
        }
    }
    subscribe: {
        enabled: boolean
        initialCursor?: Cursor
        reconnectDelayMs: number
        retry: SyncRetryConfig
        backoff: SyncBackoffConfig
    }
    lock: {
        backoff: SyncBackoffConfig
    }
}

function resolveSyncConfig(config: SyncConfig): ResolvedSyncConfig {
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
    const periodicPullBackoffBaseDelayMs = Math.max(0, Math.floor(config.periodicPullIntervalMs ?? 1_000))
    const lockBackoffBaseDelayMs = Math.max(0, Math.floor(config.reconnectDelayMs ?? 300))
    const retry = config.retry ?? { maxAttempts: 10 }
    const initialCursor = config.initialCursor

    return {
        push: {
            maxItems: Math.max(1, Math.floor(config.maxPushItems ?? 50)),
            returning: config.returning !== false,
            conflictStrategy: config.conflictStrategy,
            retry,
            backoff: resolveBackoff({ baseDelayMs: 300 })
        },
        pull: {
            limit: Math.max(1, Math.floor(config.pullLimit ?? 200)),
            resources: config.resources,
            initialCursor,
            periodic: {
                intervalMs: periodicPullIntervalMs,
                retry,
                backoff: resolveBackoff({ baseDelayMs: periodicPullBackoffBaseDelayMs })
            }
        },
        subscribe: {
            enabled: config.subscribe === true,
            initialCursor,
            reconnectDelayMs,
            retry,
            backoff: resolveBackoff({ baseDelayMs: reconnectDelayMs })
        },
        lock: {
            backoff: resolveBackoff({ baseDelayMs: lockBackoffBaseDelayMs })
        }
    }
}

export class SyncEngine implements SyncClient {
    private disposed = false
    private started = false

    private readonly resolved: ResolvedSyncConfig

    private readonly outbox
    private readonly cursor
    private readonly applier

    private readonly pushLane: PushLane
    private readonly pullLane: PullLane
    private readonly subscribeLane: SubscribeLane
    private periodicPullTimer?: ReturnType<typeof setTimeout>
    private readonly periodicPullRetry: RetryBackoff
    private lock?: SingleInstanceLock
    private startInFlight?: Promise<void>
    private readonly transport: SyncTransport

    constructor(private readonly config: SyncConfig) {
        const transport = (config as any)?.transport
        const opsClient = transport?.opsClient
        if (!transport || !opsClient || typeof opsClient.executeOps !== 'function' || typeof transport.subscribe !== 'function') {
            throw new Error('[Sync] transport is required')
        }

        this.resolved = resolveSyncConfig(config)
        this.periodicPullRetry = new RetryBackoff({
            retry: this.resolved.pull.periodic.retry,
            backoff: this.resolved.pull.periodic.backoff
        })

        this.transport = config.transport

        const stores = createStores({
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
            maxPushItems: this.resolved.push.maxItems,
            returning: this.resolved.push.returning,
            conflictStrategy: this.resolved.push.conflictStrategy,
            retry: this.resolved.push.retry,
            backoff: this.resolved.push.backoff,
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
            pullLimit: this.resolved.pull.limit,
            resources: this.resolved.pull.resources,
            initialCursor: this.resolved.pull.initialCursor,
            buildMeta: () => this.buildMeta(),
            nextOpId: (prefix) => this.nextOpId(prefix),
            onError: config.onError,
            onEvent: config.onEvent
        })

        this.subscribeLane = new SubscribeLane({
            cursor: this.cursor,
            transport: this.transport,
            applier: this.applier,
            initialCursor: this.resolved.subscribe.initialCursor,
            reconnectDelayMs: this.resolved.subscribe.reconnectDelayMs,
            retry: this.resolved.subscribe.retry,
            backoff: this.resolved.subscribe.backoff,
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
            : Protocol.ids.createIdempotencyKey({ now: () => this.now() })
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
            backoff: this.resolved.lock.backoff,
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
        this.subscribeLane.setEnabled(this.resolved.subscribe.enabled)
        this.pushLane.requestFlush()
        this.schedulePeriodicPull(0)
        this.config.onEvent?.({ type: 'lifecycle:started' })
    }

    private schedulePeriodicPull(delayMs: number) {
        if (this.disposed || !this.started) return
        this.clearPeriodicPull()
        const interval = this.resolved.pull.periodic.intervalMs
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
            this.periodicPullRetry.reset()
            this.schedulePeriodicPull(this.resolved.pull.periodic.intervalMs)
        } catch (error) {
            const { attempt, delayMs, stop } = this.periodicPullRetry.next()
            if (stop) return
            this.config.onEvent?.({ type: 'pull:backoff', attempt, delayMs })
            this.schedulePeriodicPull(delayMs)
        }
    }

    private nextOpId(prefix: 'w' | 'c') {
        return Protocol.ids.createOpId(prefix, { now: () => this.now() })
    }
}
