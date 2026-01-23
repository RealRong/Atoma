import type { Meta } from 'atoma/protocol'
import { AbortError, toError } from '#sync/internal'
import { runPeriodic } from '#sync/internal/periodic'
import { NotifyLane } from '#sync/lanes/NotifyLane'
import { PullLane } from '#sync/lanes/PullLane'
import { PushLane } from '#sync/lanes/PushLane'
import { SingleInstanceLock } from '#sync/policies/singleInstanceLock'
import type {
    CursorStore,
    OutboxStore,
    SyncApplier,
    SyncClient,
    SyncEvent,
    SyncOutboxItem,
    SyncPhase,
    SyncRuntimeConfig,
    SyncTransport
} from '#sync/types'

type EngineState = 'idle' | 'starting' | 'running' | 'disposed'

export class SyncEngine implements SyncClient {
    private disposed = false
    private state: EngineState = 'idle'
    private startPromise: Promise<void> | null = null

    private readonly config: SyncRuntimeConfig
    private readonly transport: SyncTransport
    private readonly outbox?: OutboxStore
    private readonly cursor: CursorStore
    private readonly applier: SyncApplier

    private lock?: SingleInstanceLock
    private runController: AbortController | null = null

    private readonly pushLane: PushLane | null
    private readonly pullLane: PullLane
    private readonly notifyLane: NotifyLane

    private periodicPullController: AbortController | null = null
    private periodicPullPromise: Promise<void> | null = null

    constructor(config: SyncRuntimeConfig) {
        this.config = config

        this.transport = this.config.transport
        this.outbox = this.config.outbox
        this.cursor = this.config.cursor
        this.applier = this.config.applier

        this.pushLane = this.outbox
            ? new PushLane({
                outbox: this.outbox,
                transport: this.transport,
                applier: this.applier,
                maxPushItems: this.config.push.maxItems,
                returning: this.config.push.returning,
                conflictStrategy: this.config.push.conflictStrategy,
                retry: this.config.push.retry,
                backoff: this.config.push.backoff,
                now: () => this.now(),
                buildMeta: () => this.buildMeta(),
                onError: (error, context) => this.emitError(error, context),
                onEvent: (event) => this.emitEvent(event)
            })
            : null
        this.pushLane?.setEnabled(false)

        this.pullLane = new PullLane({
            cursor: this.cursor,
            transport: this.transport,
            applier: this.applier,
            pullLimit: this.config.pull.limit,
            debounceMs: this.config.pull.debounceMs,
            resources: this.config.pull.resources,
            initialCursor: this.config.pull.initialCursor,
            buildMeta: () => this.buildMeta(),
            onError: (error, context) => this.emitError(error, context),
            onEvent: (event) => this.emitEvent(event),
            retry: this.config.pull.periodic.retry,
            backoff: this.config.pull.periodic.backoff
        })

        this.notifyLane = new NotifyLane({
            transport: this.transport,
            resources: this.config.pull.resources,
            reconnectDelayMs: this.config.subscribe.reconnectDelayMs,
            retry: this.config.subscribe.retry,
            backoff: this.config.subscribe.backoff,
            onNotify: (msg) => {
                void this.pullLane.requestPull({ cause: 'notify', resources: msg.resources }).catch(() => {
                    // error already reported via PullLane.onError
                })
            },
            onError: (error, context) => this.emitError(error, context),
            onEvent: (event) => this.emitEvent(event)
        })

        this.attachOutboxEvents()
    }

    start() {
        if (this.disposed) return
        void this.ensureStarted().catch(() => {
            // errors are already routed via onError/onEvent
        })
    }

    stop() {
        if (this.disposed) return
        void this.stopInternal('[Sync] stopped')
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.state = 'disposed'

        void this.stopInternal('[Sync] disposed').finally(() => {
            this.pushLane?.dispose()
            this.pullLane.dispose()
            this.notifyLane.dispose()
        })
    }

    async flush() {
        if (this.disposed) throw new Error('SyncEngine disposed')
        if (!this.config.push.enabled || !this.pushLane) {
            throw new Error('[Sync] push is disabled')
        }
        await this.ensureRunning()
        await this.pushLane.flush()
    }

    async pull() {
        if (this.disposed) throw new Error('SyncEngine disposed')
        if (!this.config.pull.enabled) {
            throw new Error('[Sync] pull is disabled')
        }
        await this.ensureRunning()
        return this.pullLane.requestPull({ cause: 'manual' })
    }

    private async ensureRunning(): Promise<void> {
        if (this.disposed) throw new Error('SyncEngine disposed')
        await this.ensureStarted()
        if (this.state !== 'running' || !this.lock) {
            throw new Error('[Sync] not started')
        }
    }

    private async ensureStarted(): Promise<void> {
        if (this.disposed) throw new Error('SyncEngine disposed')
        if (this.state === 'running') return
        if (this.startPromise) return this.startPromise

        this.state = 'starting'
        this.emitEvent({ type: 'lifecycle:starting' })

        const start = this.startWithLock()
            .catch((error) => {
                const err = toError(error)
                if (err instanceof AbortError) return
                // lock acquire failures are already emitted; treat others as lifecycle errors
                this.emitError(err, { phase: 'lifecycle' })
            })
            .finally(() => {
                this.startPromise = null
            })

        this.startPromise = start
        return start
    }

    private async startWithLock(): Promise<void> {
        if (this.disposed) return
        if (this.state === 'running') return

        // Cancel any previous run.
        await this.stopInternal('[Sync] restart')

        const controller = new AbortController()
        this.runController = controller

        const lock = new SingleInstanceLock({
            key: this.config.lock.key,
            ttlMs: Math.max(1000, Math.floor(this.config.lock.ttlMs ?? 10_000)),
            renewIntervalMs: Math.max(200, Math.floor(this.config.lock.renewIntervalMs ?? 3_000)),
            now: () => this.now(),
            maxAcquireAttempts: 5,
            backoff: this.config.lock.backoff,
            onLost: (error) => {
                this.onLockLost(error)
            }
        })

        try {
            await lock.acquire({ signal: controller.signal })
        } catch (error) {
            if (controller.signal.aborted || error instanceof AbortError) {
                this.state = 'idle'
                return
            }
            const err = toError(error)
            this.emitEvent({ type: 'lifecycle:lock_failed', error: err })
            this.emitError(err, { phase: 'lifecycle' })
            this.state = 'idle'
            return
        }

        if (controller.signal.aborted) {
            await lock.release().catch(() => {
                // ignore
            })
            this.state = 'idle'
            return
        }

        this.lock = lock
        this.state = 'running'
        this.emitEvent({ type: 'lifecycle:started' })

        // Link run cancellation to lanes.
        this.notifyLane.setRunSignal(controller.signal)
        this.pullLane.setRunSignal(controller.signal)
        this.pushLane?.setRunSignal(controller.signal)

        this.notifyLane.start()
        this.notifyLane.setEnabled(this.config.subscribe.enabled)

        this.pushLane?.setEnabled(Boolean(this.config.push.enabled))
        if (this.config.push.enabled) {
            this.pushLane?.requestFlush()
        }

        if (this.config.pull.enabled) {
            this.startPeriodicPull({ initialDelayMs: 0, runSignal: controller.signal })
        }
    }

    private onLockLost(error: Error) {
        const err = toError(error)
        this.emitEvent({ type: 'lifecycle:lock_lost', error: err })
        this.emitError(err, { phase: 'lifecycle' })
        void this.stopInternal('[Sync] lock lost')
    }

    private async stopInternal(reason: string): Promise<void> {
        const controller = this.runController
        this.runController = null
        if (controller && !controller.signal.aborted) {
            try {
                controller.abort(new AbortError(reason))
            } catch {
                // ignore
            }
        }

        this.stopPeriodicPull()

        this.notifyLane.stop()
        this.pushLane?.setEnabled(false)
        this.pullLane.stop(reason)

        const lock = this.lock
        this.lock = undefined
        await lock?.release().catch(() => {
            // ignore
        })

        if (!this.disposed) {
            this.state = 'idle'
            this.emitEvent({ type: 'lifecycle:stopped' })
        }
    }

    private startPeriodicPull(args: { initialDelayMs: number; runSignal: AbortSignal }) {
        if (this.disposed || this.state !== 'running') return
        if (!this.config.pull.enabled) return
        if (this.periodicPullPromise) return

        const intervalMs = Math.max(0, Math.floor(this.config.pull.periodic.intervalMs))
        if (intervalMs <= 0) return

        const controller = new AbortController()
        this.periodicPullController = controller

        const onRunAbort = () => {
            try {
                controller.abort(new AbortError('[Sync] periodic pull stopped'))
            } catch {
                // ignore
            }
        }
        if (args.runSignal.aborted) onRunAbort()
        else args.runSignal.addEventListener('abort', onRunAbort, { once: true })

        this.periodicPullPromise = (async () => {
            try {
                await runPeriodic({
                    intervalMs,
                    initialDelayMs: args.initialDelayMs,
                    signal: controller.signal,
                    shouldContinue: () => !this.disposed && this.state === 'running' && this.config.pull.enabled,
                    runOnce: async () => {
                        await this.pullLane.requestPull({ cause: 'periodic' })
                    }
                })
            } catch (error) {
                if (error instanceof AbortError) return
                const err = toError(error)
                this.emitError(err, { phase: 'pull' })
            }
        })().finally(() => {
            this.periodicPullPromise = null
            this.periodicPullController = null
        })
    }

    private stopPeriodicPull() {
        const controller = this.periodicPullController
        this.periodicPullController = null
        if (!controller) return
        try {
            controller.abort(new AbortError('[Sync] periodic pull stopped'))
        } catch {
            // ignore
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

    private emitEvent(event: SyncEvent) {
        try {
            this.config.onEvent?.(event)
        } catch {
            // ignore
        }
    }

    private emitError(error: unknown, context: { phase: SyncPhase }) {
        try {
            this.config.onError?.(toError(error), context)
        } catch {
            // ignore
        }
    }

    private attachOutboxEvents() {
        const outbox = this.outbox
        if (!outbox?.setEvents) return

        const onQueueChange = (stats: any) => {
            const pending = Math.max(0, Math.floor((stats as any)?.pending ?? 0))
            const inFlight = Math.max(0, Math.floor((stats as any)?.inFlight ?? 0))
            const total = Math.max(0, Math.floor((stats as any)?.total ?? pending + inFlight))
            const next = { pending, inFlight, total } as const
            this.emitEvent({ type: 'outbox:queue', stats: next })
            try {
                this.config.outboxEvents?.onQueueChange?.(next)
            } catch {
                // ignore
            }
            if (next.pending > 0) {
                this.requestPushFlush()
            }
        }

        const onQueueFull = (stats: any, maxQueueSize: number) => {
            const pending = Math.max(0, Math.floor((stats as any)?.pending ?? 0))
            const inFlight = Math.max(0, Math.floor((stats as any)?.inFlight ?? 0))
            const total = Math.max(0, Math.floor((stats as any)?.total ?? pending + inFlight))
            const next = { pending, inFlight, total } as const
            this.emitEvent({ type: 'outbox:queue_full', stats: next, maxQueueSize })
            try {
                this.config.outboxEvents?.onQueueFull?.(next, maxQueueSize)
            } catch {
                // ignore
            }
        }

        outbox.setEvents({ onQueueChange, onQueueFull })

        try {
            void outbox.stats().then(onQueueChange).catch(() => {
                // ignore
            })
        } catch {
            // ignore
        }
    }

    private requestPushFlush() {
        if (this.disposed || this.state !== 'running') return
        if (!this.config.push.enabled || !this.pushLane) return
        this.pushLane.requestFlush()
    }
}

