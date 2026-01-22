import pRetry, { AbortError } from 'p-retry'
import { createActor, createMachine, fromPromise, waitFor } from 'xstate'
import type { Meta } from 'atoma/protocol'
import { toError } from '#sync/internal'
import { runPeriodic } from '#sync/internal/periodic'
import { NotifyLane } from '#sync/lanes/NotifyLane'
import { PullLane } from '#sync/lanes/PullLane'
import { PushLane } from '#sync/lanes/PushLane'
import { estimateDelayFromRetryContext, resolveRetryOptions } from '#sync/policies/retryPolicy'
import { SingleInstanceLock } from '#sync/policies/singleInstanceLock'
import type {
    CursorStore,
    OutboxEvents,
    OutboxReader,
    SyncApplier,
    SyncClient,
    SyncEvent,
    SyncOutboxItem,
    SyncPhase,
    SyncRuntimeConfig,
    SyncTransport
} from '#sync/types'

type SyncMachineState = { value: 'idle' | 'starting' | 'running' | 'disposed' }

export class SyncEngine implements SyncClient {
    private disposed = false
    private readonly config: SyncRuntimeConfig

    private readonly transport: SyncTransport
    private readonly outbox?: OutboxReader & OutboxEvents
    private readonly cursor: CursorStore
    private readonly applier: SyncApplier

    private lock?: SingleInstanceLock

    private readonly pushLane: PushLane | null
    private readonly pullLane: PullLane
    private readonly notifyLane: NotifyLane

    private periodicPullController?: AbortController
    private periodicPullPromise?: Promise<void>

    private readonly actor = createActor(
        createMachine(
            {
                id: 'sync',
                initial: 'idle',
                states: {
                    idle: {
                        on: {
                            START: { target: 'starting', actions: 'emitStarting' },
                            DISPOSE: { target: 'disposed', actions: 'disposeAll' }
                        }
                    },
                    starting: {
                        invoke: {
                            src: 'acquireLock',
                            input: () => ({
                                sendLockLost: (error: Error) => {
                                    this.actor.send({ type: 'LOCK_LOST', error })
                                }
                            }),
                            onDone: { target: 'running', actions: 'onLockAcquired' },
                            onError: { target: 'idle', actions: 'onLockFailed' }
                        },
                        on: {
                            STOP: { target: 'idle', actions: 'stopAll' },
                            DISPOSE: { target: 'disposed', actions: 'disposeAll' }
                        }
                    },
                    running: {
                        entry: 'startLanes',
                        exit: 'stopAll',
                        on: {
                            STOP: { target: 'idle' },
                            LOCK_LOST: { target: 'idle', actions: 'onLockLost' },
                            DISPOSE: { target: 'disposed', actions: 'disposeAll' }
                        }
                    },
                    disposed: {
                        type: 'final'
                    }
                }
            },
            {
                actors: {
                    acquireLock: fromPromise(async ({ input, signal }) => {
                        const lock = new SingleInstanceLock({
                            key: this.config.lock.key,
                            ttlMs: Math.max(1000, Math.floor(this.config.lock.ttlMs ?? 10_000)),
                            renewIntervalMs: Math.max(200, Math.floor(this.config.lock.renewIntervalMs ?? 3_000)),
                            now: () => this.now(),
                            maxAcquireAttempts: 5,
                            backoff: this.config.lock.backoff,
                            onLost: (error) => {
                                ;(input as any)?.sendLockLost?.(error)
                            }
                        })

                        await lock.acquire()

                        if (signal.aborted) {
                            await lock.release().catch(() => {
                                // ignore
                            })
                            throw new AbortError('aborted')
                        }

                        return lock
                    })
                },
                actions: {
                    emitStarting: () => {
                        this.emitEvent({ type: 'lifecycle:starting' })
                    },
                    onLockAcquired: ({ event }: any) => {
                        const lock = event.output as SingleInstanceLock
                        this.lock = lock
                        this.emitEvent({ type: 'lifecycle:started' })
                    },
                    onLockFailed: ({ event }: any) => {
                        const err = toError(event.error)
                        this.emitEvent({ type: 'lifecycle:lock_failed', error: err })
                        this.emitError(err, { phase: 'lifecycle' })
                        this.lock = undefined
                    },
                    onLockLost: ({ event }: any) => {
                        const err = toError(event.error)
                        this.emitEvent({ type: 'lifecycle:lock_lost', error: err })
                        this.emitError(err, { phase: 'lifecycle' })
                    },
                    startLanes: () => {
                        this.notifyLane.start()
                        this.notifyLane.setEnabled(this.config.subscribe.enabled)

                        this.pushLane?.setEnabled(Boolean(this.config.push.enabled))
                        if (this.config.push.enabled) {
                            this.pushLane?.requestFlush()
                        }

                        if (this.config.pull.enabled) {
                            this.startPeriodicPull({ initialDelayMs: 0 })
                        }
                    },
                    stopAll: () => {
                        this.notifyLane.stop()
                        this.pushLane?.setEnabled(false)
                        this.stopPeriodicPull()
                        this.pullLane.stop('[Sync] stopped')

                        const lock = this.lock
                        this.lock = undefined
                        void lock?.release().catch(() => {
                            // ignore
                        })

                        this.emitEvent({ type: 'lifecycle:stopped' })
                    },
                    disposeAll: () => {
                        if (this.disposed) return
                        this.disposed = true
                        this.notifyLane.stop()
                        this.pushLane?.dispose()
                        this.pullLane.dispose()
                        this.notifyLane.dispose()
                        this.stopPeriodicPull()

                        const lock = this.lock
                        this.lock = undefined
                        void lock?.release().catch(() => {
                            // ignore
                        })
                    }
                }
            }
        )
    ) as any

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
            onEvent: (event) => this.emitEvent(event)
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
        this.actor.start()
    }

    start() {
        if (this.disposed) return
        this.actor.send({ type: 'START' })
    }

    stop() {
        if (this.disposed) return
        this.actor.send({ type: 'STOP' })
    }

    dispose() {
        if (this.disposed) return
        this.actor.send({ type: 'DISPOSE' })
        this.actor.stop?.()
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

    private isRunning(): boolean {
        const snap = this.actor.getSnapshot?.() as SyncMachineState | undefined
        return snap?.value === 'running'
    }

    private async ensureRunning(): Promise<void> {
        if (this.disposed) throw new Error('SyncEngine disposed')
        if (this.isRunning() && this.lock) return
        this.start()
        await waitFor(this.actor, (state: SyncMachineState) => state.value === 'running' || state.value === 'idle' || state.value === 'disposed')
        if (!this.isRunning() || !this.lock) {
            throw new Error('[Sync] not started')
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

        const onQueueChange = (size: number) => {
            const next = Math.max(0, Math.floor(size))
            this.emitEvent({ type: 'outbox:queue', size: next })
            try {
                this.config.outboxEvents?.onQueueChange?.(next)
            } catch {
                // ignore
            }
            if (next > 0) {
                this.requestPushFlush()
            }
        }

        const onQueueFull = (droppedOp: SyncOutboxItem, maxQueueSize: number) => {
            this.emitEvent({ type: 'outbox:queue_full', droppedOp, maxQueueSize })
            try {
                this.config.outboxEvents?.onQueueFull?.(droppedOp, maxQueueSize)
            } catch {
                // ignore
            }
        }

        outbox.setEvents({ onQueueChange, onQueueFull })

        try {
            const snapshot = outbox.size()
            if (typeof snapshot === 'number') {
                onQueueChange(snapshot)
            } else {
                snapshot.then(onQueueChange).catch(() => {
                    // ignore
                })
            }
        } catch {
            // ignore
        }
    }

    private requestPushFlush() {
        if (this.disposed || !this.isRunning()) return
        if (!this.config.push.enabled || !this.pushLane) return
        this.pushLane.requestFlush()
    }

    private startPeriodicPull(args: { initialDelayMs: number }) {
        if (this.disposed || !this.isRunning()) return
        if (!this.config.pull.enabled) return
        if (this.periodicPullPromise) return

        const intervalMs = Math.max(0, Math.floor(this.config.pull.periodic.intervalMs))
        if (intervalMs <= 0) return

        const controller = new AbortController()
        this.periodicPullController = controller

        const retryOptions = resolveRetryOptions({
            retry: this.config.pull.periodic.retry,
            backoff: this.config.pull.periodic.backoff,
            unref: true,
            signal: controller.signal
        })

        this.periodicPullPromise = (async () => {
            try {
                await runPeriodic({
                    intervalMs,
                    initialDelayMs: args.initialDelayMs,
                    signal: controller.signal,
                    shouldContinue: () => !this.disposed && this.isRunning() && this.config.pull.enabled,
                    runOnce: async () => {
                        await pRetry(
                            () => this.pullLane.requestPull({ cause: 'periodic' }),
                            {
                                ...retryOptions,
                                onFailedAttempt: (ctx) => {
                                    const delayMs = estimateDelayFromRetryContext(ctx, retryOptions)
                                    this.emitEvent({ type: 'pull:backoff', attempt: ctx.attemptNumber, delayMs })
                                },
                                shouldRetry: (ctx) => !(ctx.error instanceof AbortError)
                            }
                        )
                    }
                })
            } catch (error) {
                if (error instanceof AbortError) return
                throw error
            }
        })().finally(() => {
            this.periodicPullPromise = undefined
            this.periodicPullController = undefined
        })
    }

    private stopPeriodicPull() {
        try {
            this.periodicPullController?.abort(new AbortError('[Sync] periodic pull stopped'))
        } catch {
            // ignore
        }
    }

}
