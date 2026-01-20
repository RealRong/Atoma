import { Observability } from '#observability'
import { Sync, type CursorStore, type OutboxStore, type SyncApplier, type SyncClient, type SyncCreateConfig, type SyncEvent, type SyncOutboxEvents, type SyncOutboxItem, type SyncPhase, type SyncTransport } from '#sync'
import type { AtomaClientSyncConfig, AtomaSyncStartMode, ResolvedBackend, AtomaSync } from '../../types'
import type { ClientRuntimeInternal } from '../types'
import { SyncReplicatorApplier } from './SyncReplicatorApplier'
type EngineMode = AtomaSyncStartMode

export class SyncController {
    readonly sync: AtomaSync
    readonly devtools: Readonly<{
        snapshot: () => { queue?: { pending: number; failed: number }; lastEventAt?: number; lastError?: string }
        subscribe: (fn: (e: { type: string; payload?: any }) => void) => () => void
    }>
    readonly dispose: () => void

    private readonly runtime: ClientRuntimeInternal
    private readonly backend?: ResolvedBackend
    private readonly localBackend?: ResolvedBackend
    private readonly syncConfig?: AtomaClientSyncConfig
    private readonly syncConfigured: boolean
    private readonly now: () => number
    private readonly applier: SyncApplier
    private readonly outboxStore?: OutboxStore
    private readonly cursorStore?: CursorStore
    private readonly lockKey?: string

    private queuePending = 0
    private queueFailed = 0
    private lastEventAt: number | undefined
    private lastError: string | undefined

    private devtoolsSubscribers = new Set<(e: { type: string; payload?: any }) => void>()

    private syncStarted = false
    private syncEngine: SyncClient | null = null
    private engineModeKey: string | null = null

    private subscribeTraceId: string | undefined
    private subscribeRequestSequencer: ReturnType<typeof Observability.trace.createRequestSequencer> | undefined

    constructor(args: {
        runtime: ClientRuntimeInternal
        backend?: ResolvedBackend
        localBackend?: ResolvedBackend
        syncConfig?: AtomaClientSyncConfig
        outboxStore?: OutboxStore
        cursorStore?: CursorStore
        lockKey?: string
    }) {
        this.runtime = args.runtime
        this.backend = args.backend
        this.localBackend = args.localBackend
        this.syncConfig = args.syncConfig
        this.syncConfigured = Boolean(this.syncConfig)
        this.now = this.syncConfig?.now ?? (() => Date.now())
        this.applier = new SyncReplicatorApplier(this.runtime, this.backend, this.localBackend, this.syncConfig)
        this.outboxStore = args.outboxStore
        this.cursorStore = args.cursorStore
        this.lockKey = args.lockKey

        this.devtools = {
            snapshot: this.snapshotDevtools,
            subscribe: this.subscribeDevtools
        } as const

        if (this.syncConfig && !this.cursorStore) {
            throw new Error('[Atoma] sync: cursor store 未配置')
        }
        if (this.syncConfig && !this.lockKey) {
            throw new Error('[Atoma] sync: lockKey 未配置')
        }
        if (this.syncConfig?.queue && !this.outboxStore) {
            throw new Error('[Atoma] sync: queue 启用时必须提供 outbox store')
        }
        if (this.syncConfig?.queue) {
            this.attachOutboxEvents()
        }

        this.sync = {
            start: (mode) => {
                const resolved = mode ?? this.resolveDefaultStartMode()
                const engine = this.ensureSyncEngine({ mode: resolved })
                this.syncStarted = true
                engine.start()
            },
            stop: () => {
                if (!this.syncStarted) return
                this.syncStarted = false
                this.safe(() => this.syncEngine?.stop())
            },
            dispose: () => {
                this.syncStarted = false
                this.disposeEngine()
                this.subscribeTraceId = undefined
                this.subscribeRequestSequencer = undefined
            },
            status: () => ({ started: this.syncStarted, configured: this.syncConfigured }),
            pull: async () => {
                if (!this.syncStarted) {
                    this.sync.start('pull-only')
                }
                const engine = this.ensureSyncEngine({ mode: 'pull-only' })
                await engine.pull()
            },
            push: async () => {
                if (!this.syncStarted) {
                    this.sync.start('push-only')
                }
                const engine = this.ensureSyncEngine({ mode: 'push-only' })
                await engine.flush()
            }
        }

        this.dispose = () => {
            try {
                this.sync.dispose()
            } catch {
                // ignore
            }
        }
    }

    private safe = (fn: () => void) => {
        try {
            fn()
        } catch {
            // ignore
        }
    }

    private attachOutboxEvents = () => {
        if (!this.outboxStore || !this.syncConfig) return
        const syncConfig = this.syncConfig
        const outboxEvents: SyncOutboxEvents = {
            onQueueChange: (size: number) => {
                const previous = this.queuePending
                this.queuePending = Math.max(0, Math.floor(size))
                this.emitSyncDevtools('sync:queue', { pending: this.queuePending, failed: this.queueFailed })
                this.safe(() => syncConfig.outboxEvents?.onQueueChange?.(size))
                if (this.queuePending > previous && this.shouldRequestPushFlush(size)) {
                    void this.syncEngine?.flush().catch(() => {
                        // ignore
                    })
                }
            },
            onQueueFull: (droppedOp: SyncOutboxItem, maxQueueSize: number) => {
                this.queueFailed += 1
                this.emitSyncDevtools('sync:queue_full', { droppedOp, maxQueueSize })
                this.safe(() => syncConfig.outboxEvents?.onQueueFull?.(droppedOp, maxQueueSize))
            }
        }
        this.outboxStore.setEvents?.(outboxEvents)
        const snapshot = this.outboxStore.size()
        if (typeof snapshot === 'number') {
            this.queuePending = Math.max(0, Math.floor(snapshot))
            this.emitSyncDevtools('sync:queue', { pending: this.queuePending, failed: this.queueFailed })
        } else {
            snapshot.then((size) => {
                this.queuePending = Math.max(0, Math.floor(size))
                this.emitSyncDevtools('sync:queue', { pending: this.queuePending, failed: this.queueFailed })
            }).catch(() => {
                // ignore
            })
        }
    }

    private shouldRequestPushFlush = (pending: number) => {
        if (!this.syncStarted || !this.syncEngine) return false
        if (pending <= 0) return false
        return this.engineModeKey === 'full' || this.engineModeKey === 'push-only'
    }

    private emitDevtools = (e: { type: string; payload?: any }) => {
        if (!this.devtoolsSubscribers.size) return
        for (const sub of this.devtoolsSubscribers) {
            try {
                sub(e)
            } catch {
                // ignore
            }
        }
    }

    private emitSyncDevtools = (type: string, payload?: any) => {
        this.lastEventAt = this.now()
        this.emitDevtools({ type, payload })
    }

    private snapshotDevtools = () => {
        if (!this.syncConfigured) return {}
        return {
            queue: { pending: this.queuePending, failed: this.queueFailed },
            ...(typeof this.lastEventAt === 'number' ? { lastEventAt: this.lastEventAt } : {}),
            ...(this.lastError ? { lastError: this.lastError } : {})
        }
    }

    private subscribeDevtools = (fn: (e: { type: string; payload?: any }) => void) => {
        this.devtoolsSubscribers.add(fn)
        return () => {
            this.devtoolsSubscribers.delete(fn)
        }
    }

    private disposeEngine = () => {
        if (!this.syncEngine) return
        this.safe(() => this.syncEngine?.stop())
        this.safe(() => this.syncEngine?.dispose())
        this.syncEngine = null
        this.engineModeKey = null
    }

    private buildSubscribeUrl = (args2?: { resources?: string[] }): string => {
        const backend = this.backend
        if (!backend?.sse?.buildUrl) {
            throw new Error('[Atoma] sync: subscribe 已启用，但未配置 SSE subscribeUrl（请配置 sync.sse，或在 sync.backend.sse.subscribeUrl 提供 buildUrl）')
        }
        const base = backend.sse.buildUrl({ resources: args2?.resources })

        if (!this.subscribeTraceId) {
            this.subscribeTraceId = Observability.trace.createId()
        }
        if (!this.subscribeRequestSequencer) {
            this.subscribeRequestSequencer = Observability.trace.createRequestSequencer()
        }

        const requestId = this.subscribeRequestSequencer.next(this.subscribeTraceId)
        return withQueryParams(base, { traceId: this.subscribeTraceId, requestId })
    }

    private resolveDefaultStartMode = (): 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full' => {
        const configured = this.syncConfig?.mode
        if (configured) return configured

        const hasQueueWrites = Boolean(this.syncConfig?.queue)
        if (hasQueueWrites) return 'full'
        const wantSubscribe = this.syncConfig?.subscribe !== false
        const hasSubscribeCapability = Boolean(this.backend?.subscribe || this.backend?.sse?.buildUrl)
        if (wantSubscribe && !hasSubscribeCapability) return 'pull-only'
        if (wantSubscribe) return 'pull+subscribe'
        return 'pull-only'
    }

    private requireConfigured = (): { syncConfig: AtomaClientSyncConfig; backend: ResolvedBackend } => {
        if (!this.syncConfig) {
            throw new Error('[Atoma] sync: 未配置（请在 createClient 中提供 sync 配置）')
        }
        if (!this.backend) {
            throw new Error('[Atoma] sync: 未配置同步对端（请配置 sync.url 或 sync.backend）')
        }
        return { syncConfig: this.syncConfig, backend: this.backend }
    }

    private ensureSyncEngine = (args2?: { mode?: EngineMode }): SyncClient => {
        const mode: EngineMode = args2?.mode ?? 'full'
        const key = String(mode)
        if (this.syncEngine && this.engineModeKey === key) return this.syncEngine

        if (this.syncEngine && this.engineModeKey !== key) {
            this.disposeEngine()
        }

        const configured = this.requireConfigured()
        const syncConfig = configured.syncConfig
        const backend = configured.backend

        const adv = syncConfig.advanced

        const onEventWrapped = (event: SyncEvent) => {
            this.emitSyncDevtools('sync:event', event)
            this.safe(() => syncConfig.onEvent?.(event))
        }

        const onErrorWrapped = (error: Error, context: { phase: SyncPhase }) => {
            this.lastError = error?.message ? String(error.message) : String(error)
            this.emitSyncDevtools('sync:error', { error, context })
            this.safe(() => syncConfig.onError?.(error, context))
        }

        const wantsSubscribe = (mode === 'subscribe-only' || mode === 'pull+subscribe' || mode === 'full')
            && syncConfig.subscribe !== false

        const wantsPush = (mode === 'push-only' || mode === 'full')
        if (wantsPush && !this.outboxStore) {
            throw new Error('[Atoma] sync: push 模式需要配置 outbox')
        }

        if (wantsSubscribe && !backend.subscribe && !backend.sse?.buildUrl) {
            throw new Error('[Atoma] sync: subscribe 已启用，但未配置 subscribe 能力（请配置 sync.sse，或在 sync.backend 提供 subscribe/sse）')
        }

        const transport: SyncTransport = wantsSubscribe
            ? {
                opsClient: backend.opsClient,
                subscribe: backend.subscribe
                    ? backend.subscribe
                    : (subArgs) => {
                        return Sync.subscribeNotifySse({
                            resources: subArgs.resources,
                            buildUrl: this.buildSubscribeUrl,
                            eventSourceFactory: backend.sse?.eventSourceFactory,
                            eventName: syncConfig.subscribeEventName,
                            onMessage: subArgs.onMessage,
                            onError: subArgs.onError
                        })
                    }
            }
            : { opsClient: backend.opsClient }

        const {
            deviceId: _deviceId,
            advanced: _advanced,
            queue: _queue,
            subscribeEventName: _subscribeEventName,
            outboxEvents: _outboxEvents,
            onError: _onError,
            onEvent: _onEvent,
            mode: _defaultMode,
            ...syncOptions
        } = syncConfig

        const createArgs: SyncCreateConfig = {
            transport,
            applier: this.applier,
            outbox: this.outboxStore,
            cursor: this.cursorStore!,
            mode: mode as any,
            ...syncOptions,
            lockKey: adv?.lockKey ?? this.lockKey!,
            lockTtlMs: adv?.lockTtlMs,
            lockRenewIntervalMs: adv?.lockRenewIntervalMs,
            onError: onErrorWrapped,
            onEvent: onEventWrapped
        }

        this.syncEngine = Sync.create(createArgs)
        this.engineModeKey = key
        return this.syncEngine
    }
}

function withQueryParams(url: string, params: { traceId: string; requestId: string }): string {
    const t = encodeURIComponent(params.traceId)
    const r = encodeURIComponent(params.requestId)
    const join = url.includes('?') ? '&' : '?'
    return `${url}${join}traceId=${t}&requestId=${r}`
}
