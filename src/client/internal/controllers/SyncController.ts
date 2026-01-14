import { Observability } from '#observability'
import { Sync, type SyncClient, type SyncCreateConfig, type SyncEvent, type SyncOutboxEvents, type SyncOutboxItem, type SyncPhase, type SyncTransport } from '#sync'
import type { AtomaClientSyncConfig, AtomaSyncStartMode, ResolvedBackend, AtomaSync } from '../../types'
import type { ClientRuntime } from '../../types'
import { createSyncReplicatorApplier } from './SyncReplicatorApplier'

const SYNC_INSTANCE_ID_SESSION_KEY = 'atoma:sync:instanceId'

function createSyncInstanceId(): string {
    const cryptoAny = typeof crypto !== 'undefined' ? (crypto as any) : undefined
    const uuid = cryptoAny?.randomUUID?.()
    if (typeof uuid === 'string' && uuid) return `i_${uuid}`
    return `i_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
}

const resolveSyncInstanceId = (() => {
    let fallback: string | undefined

    const safeFallback = () => {
        if (!fallback) fallback = createSyncInstanceId()
        return fallback
    }

    return (): string => {
        if (typeof window === 'undefined') return safeFallback()

        let storage: Storage | undefined
        try {
            storage = window.sessionStorage
        } catch {
            storage = undefined
        }
        if (!storage) return safeFallback()

        try {
            const existing = storage.getItem(SYNC_INSTANCE_ID_SESSION_KEY)
            if (existing && existing.trim()) return existing.trim()
            const next = createSyncInstanceId()
            storage.setItem(SYNC_INSTANCE_ID_SESSION_KEY, next)
            return next
        } catch {
            return safeFallback()
        }
    }
})()

export function createSyncController(args: {
    runtime: ClientRuntime
    backend?: ResolvedBackend
    localBackend?: ResolvedBackend
    syncConfig?: AtomaClientSyncConfig
}): Readonly<{
    sync: AtomaSync
    dispose: () => void
    devtools: Readonly<{
        snapshot: () => { queue?: { pending: number; failed: number }; lastEventAt?: number; lastError?: string }
        subscribe: (fn: (e: { type: string; payload?: any }) => void) => () => void
    }>
}> {
    const syncConfig = args.syncConfig
    const syncConfigured = Boolean(syncConfig)

    const now = syncConfig?.now ?? (() => Date.now())

    type EngineMode = AtomaSyncStartMode | 'enqueue-only'

    let queuePending = 0
    let queueFailed = 0
    let lastEventAt: number | undefined
    let lastError: string | undefined

    const safe = (fn: () => void) => {
        try {
            fn()
        } catch {
            // ignore
        }
    }

    const devtoolsSubscribers = new Set<(e: { type: string; payload?: any }) => void>()

    const emitDevtools = (e: { type: string; payload?: any }) => {
        if (!devtoolsSubscribers.size) return
        for (const sub of devtoolsSubscribers) {
            try {
                sub(e)
            } catch {
                // ignore
            }
        }
    }

    const devtools = {
        snapshot: () => {
            if (!syncConfigured) return {}
            return {
                queue: { pending: queuePending, failed: queueFailed },
                ...(typeof lastEventAt === 'number' ? { lastEventAt } : {}),
                ...(lastError ? { lastError } : {})
            }
        },
        subscribe: (fn: (e: { type: string; payload?: any }) => void) => {
            devtoolsSubscribers.add(fn)
            return () => {
                devtoolsSubscribers.delete(fn)
            }
        }
    } as const

    const applier = createSyncReplicatorApplier({
        runtime: args.runtime,
        backend: args.backend,
        localBackend: args.localBackend,
        syncConfig
    })

    let syncStarted = false
    let syncEngine: SyncClient | null = null
    let engineModeKey: string | null = null

    let subscribeTraceId: string | undefined
    let subscribeRequestSequencer: ReturnType<typeof Observability.trace.createRequestSequencer> | undefined
    const emitSyncDevtools = (type: string, payload?: any) => {
        lastEventAt = now()
        emitDevtools({ type, payload })
    }

    const disposeEngine = () => {
        if (!syncEngine) return
        safe(() => syncEngine?.stop())
        safe(() => syncEngine?.dispose())
        syncEngine = null
        engineModeKey = null
    }

    function buildSubscribeUrl(args2?: { resources?: string[] }): string {
        const backend = args.backend
        if (!backend?.sse?.buildUrl) {
            throw new Error('[Atoma] sync: subscribe 已启用，但未配置 SSE subscribeUrl（请配置 sync.sse，或在 sync.backend.sse.subscribeUrl 提供 buildUrl）')
        }
        const base = backend.sse.buildUrl({ resources: args2?.resources })

        if (!subscribeTraceId) {
            subscribeTraceId = Observability.trace.createId()
        }
        if (!subscribeRequestSequencer) {
            subscribeRequestSequencer = Observability.trace.createRequestSequencer()
        }

        const requestId = subscribeRequestSequencer.next(subscribeTraceId)
        return withQueryParams(base, { traceId: subscribeTraceId, requestId })
    }

    // ---------------------------------------------
    // 1) Public API（新手先看这里）
    // ---------------------------------------------
    const resolveDefaultStartMode = (): 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full' => {
        const configured = syncConfig?.mode
        if (configured) return configured

        const hasQueueWrites = Boolean(syncConfig?.queue)
        if (hasQueueWrites) return 'full'
        const wantSubscribe = syncConfig?.subscribe !== false
        const hasSubscribeCapability = Boolean(args.backend?.subscribe || args.backend?.sse?.buildUrl)
        if (wantSubscribe && !hasSubscribeCapability) return 'pull-only'
        if (wantSubscribe) return 'pull+subscribe'
        return 'pull-only'
    }

    const sync: AtomaSync = {
        start: (mode) => {
            const resolved = mode ?? resolveDefaultStartMode()
            const engine = ensureSyncEngine({ mode: resolved })
            syncStarted = true
            engine.start()
        },
        stop: () => {
            if (!syncStarted) return
            syncStarted = false
            safe(() => syncEngine?.stop())
        },
        dispose: () => {
            syncStarted = false
            disposeEngine()
            subscribeTraceId = undefined
            subscribeRequestSequencer = undefined
        },
        status: () => ({ started: syncStarted, configured: syncConfigured }),
        pull: async () => {
            if (!syncStarted) {
                sync.start('pull-only')
            }
            const engine = ensureSyncEngine({ mode: 'pull-only' })
            await engine.pull()
        },
        push: async () => {
            if (!syncStarted) {
                sync.start('push-only')
            }
            const engine = ensureSyncEngine({ mode: 'push-only' })
            await engine.flush()
        }
    }

    // ---------------------------------------------
    // 2) Engine（只做构造与缓存）
    // ---------------------------------------------
    const syncDefaultsKey = args.backend?.key ? String(args.backend.key) : 'default'
    const syncInstanceId = (syncConfig?.deviceId && String(syncConfig.deviceId).trim())
        ? String(syncConfig.deviceId).trim()
        : resolveSyncInstanceId()
    const defaultOutboxKey = `atoma:sync:${syncDefaultsKey}:${syncInstanceId}:outbox`
    const defaultCursorKey = `atoma:sync:${syncDefaultsKey}:${syncInstanceId}:cursor`

    const requireConfigured = (): { syncConfig: AtomaClientSyncConfig; backend: ResolvedBackend } => {
        if (!syncConfig) {
            throw new Error('[Atoma] sync: 未配置（请在 createClient 中提供 sync 配置）')
        }
        if (!args.backend) {
            throw new Error('[Atoma] sync: 未配置同步对端（请配置 sync.url 或 sync.backend）')
        }
        return { syncConfig, backend: args.backend }
    }

    function ensureSyncEngine(args2?: { mode?: EngineMode }): SyncClient {
        const mode: EngineMode = args2?.mode ?? 'full'
        const key = String(mode)
        if (syncEngine && engineModeKey === key) return syncEngine

        if (syncEngine && engineModeKey !== key) {
            disposeEngine()
        }

        const configured = requireConfigured()
        const syncConfig = configured.syncConfig
        const backend = configured.backend

        const adv = syncConfig.advanced
        const outboxKey = adv?.outboxKey ?? defaultOutboxKey
        const cursorKey = adv?.cursorKey ?? defaultCursorKey

        const onEventWrapped = (event: SyncEvent) => {
            emitSyncDevtools('sync:event', event)
            safe(() => syncConfig.onEvent?.(event))
        }

        const onErrorWrapped = (error: Error, context: { phase: SyncPhase }) => {
            lastError = error?.message ? String(error.message) : String(error)
            emitSyncDevtools('sync:error', { error, context })
            safe(() => syncConfig.onError?.(error, context))
        }

        const outboxEvents: SyncOutboxEvents = {
            onQueueChange: (size: number) => {
                queuePending = Math.max(0, Math.floor(size))
                emitSyncDevtools('sync:queue', { pending: queuePending, failed: queueFailed })
                safe(() => syncConfig.outboxEvents?.onQueueChange?.(size))
            },
            onQueueFull: (droppedOp: SyncOutboxItem, maxQueueSize: number) => {
                queueFailed += 1
                emitSyncDevtools('sync:queue_full', { droppedOp, maxQueueSize })
                safe(() => syncConfig.outboxEvents?.onQueueFull?.(droppedOp, maxQueueSize))
            }
        }

        const wantsSubscribe = (mode === 'subscribe-only' || mode === 'pull+subscribe' || mode === 'full')
            && syncConfig.subscribe !== false

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
                            buildUrl: buildSubscribeUrl,
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
            applier,
            outboxKey,
            cursorKey,
            mode: mode as any,
            ...syncOptions,
            outboxEvents,
            lockKey: adv?.lockKey,
            lockTtlMs: adv?.lockTtlMs,
            lockRenewIntervalMs: adv?.lockRenewIntervalMs,
            onError: onErrorWrapped,
            onEvent: onEventWrapped
        }

        syncEngine = Sync.create(createArgs)
        engineModeKey = key
        return syncEngine
    }

    // ---------------------------------------------
    // 3) Intent（outbox 写语义）
    // ---------------------------------------------
    if (syncConfig?.queue) {
        args.runtime.installOutboxRuntime({
            queueMode: syncConfig.queue === 'local-first' ? 'local-first' : 'queue',
            ensureEnqueuer: () => {
                const engine = ensureSyncEngine({ mode: 'enqueue-only' })
                return {
                    enqueueWrite: async (enqueueArgs) => {
                        await engine.enqueueWrite(enqueueArgs)
                    }
                }
            }
        })
    }

    // ---------------------------------------------
    // 6) Dispose
    // ---------------------------------------------
    const dispose = () => {
        try {
            sync.dispose()
        } catch {
            // ignore
        }
    }

    return {
        sync,
        dispose,
        devtools
    }
}

function withQueryParams(url: string, params: { traceId: string; requestId: string }): string {
    const t = encodeURIComponent(params.traceId)
    const r = encodeURIComponent(params.requestId)
    const join = url.includes('?') ? '&' : '?'
    return `${url}${join}traceId=${t}&requestId=${r}`
}
