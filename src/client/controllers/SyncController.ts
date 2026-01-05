import { Observability } from '#observability'
import { Sync, type SyncClient } from '#sync'
import type { AtomaClientSyncConfig, ResolvedBackend, AtomaSync } from '../types'
import type { ClientRuntime } from '../runtime'
import { createSyncIntentController } from './SyncIntentController'
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
}> {
    const syncConfig = args.syncConfig
    const syncConfigured = Boolean(syncConfig)

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

    // ---------------------------------------------
    // 1) Public API（新手先看这里）
    // ---------------------------------------------
    const resolveDefaultStartMode = (): 'full' | 'pull+subscribe' | 'pull-only' => {
        const hasQueueWrites = Boolean(syncConfig && (syncConfig as any)?.queueWriteMode)
        if (hasQueueWrites) return 'full'
        const wantSubscribe = syncConfig?.subscribe !== false
        const hasSubscribeCapability = Boolean(args.backend?.subscribe || args.backend?.sse?.buildUrl)
        if (wantSubscribe && !hasSubscribeCapability) return 'pull-only'
        if (wantSubscribe) return 'pull+subscribe'
        return 'pull-only'
    }

    const resolveStartMode = (mode?: string): { mode: 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full' } => {
        const m = typeof mode === 'string' && mode ? mode : resolveDefaultStartMode()
        if (m === 'pull-only' || m === 'subscribe-only' || m === 'pull+subscribe' || m === 'push-only' || m === 'full') return { mode: m }
        throw new Error(`[Atoma] Sync.start: unsupported mode (${String(mode)})`)
    }

    const sync: AtomaSync = {
        start: (args) => {
            const { mode } = resolveStartMode(args?.mode)
            const engine = ensureSyncEngine({ mode })
            syncStarted = true
            engine.start()
        },
        stop: () => {
            if (!syncStarted) return
            syncStarted = false
            syncEngine?.stop()
        },
        status: () => ({ started: syncStarted, configured: syncConfigured }),
        pull: async () => {
            if (!syncStarted) {
                sync.start({ mode: 'pull-only' } as any)
            }
            const engine = ensureSyncEngine({ mode: 'pull-only' })
            await engine.pull()
        },
        flush: async () => {
            if (!syncStarted) {
                sync.start({ mode: 'push-only' } as any)
            }
            const engine = ensureSyncEngine({ mode: 'push-only' })
            await engine.flush()
        },
        setSubscribed: (enabled: boolean) => {
            const engine = ensureSyncEngine({ mode: 'pull+subscribe' })
            engine.setSubscribed(Boolean(enabled))
        }
    }

    // ---------------------------------------------
    // 2) Engine（只做构造与缓存）
    // ---------------------------------------------
    const syncDefaultsKey = args.backend?.key ? String(args.backend.key) : 'default'
    const syncInstanceId = resolveSyncInstanceId()
    const defaultOutboxKey = `atoma:sync:${syncDefaultsKey}:${syncInstanceId}:outbox`
    const defaultCursorKey = `atoma:sync:${syncDefaultsKey}:${syncInstanceId}:cursor`

    function ensureSyncEngine(args2?: { mode?: 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full' | 'enqueue-only' }): SyncClient {
        const mode = args2?.mode ?? 'full'
        const key = String(mode)
        if (syncEngine && engineModeKey === key) return syncEngine

        if (syncEngine && engineModeKey !== key) {
            try {
                syncEngine.stop()
            } catch {
                // ignore
            }
            try {
                syncEngine.dispose()
            } catch {
                // ignore
            }
            syncEngine = null
            engineModeKey = null
        }

        if (!syncConfig) {
            throw new Error('[Atoma] sync: 未配置（请通过 builder 配置 sync.target / sync.defaults / sync.queueWrites）')
        }
        if (!args.backend) {
            throw new Error('[Atoma] sync: 未配置同步对端（sync.target）')
        }

        const outboxKey = syncConfig.outboxKey ?? defaultOutboxKey
        const cursorKey = syncConfig.cursorKey ?? defaultCursorKey

        const backend = args.backend

        const modeConfig = (() => {
            if (mode === 'enqueue-only') {
                return { push: false, pull: false, subscribe: false, periodicPullIntervalMs: 0 }
            }
            if (mode === 'pull-only') {
                return { push: false, pull: true, subscribe: false }
            }
            if (mode === 'subscribe-only') {
                return { push: false, pull: true, subscribe: true, periodicPullIntervalMs: 0 }
            }
            if (mode === 'pull+subscribe') {
                return { push: false, pull: true, subscribe: true }
            }
            if (mode === 'push-only') {
                return { push: true, pull: false, subscribe: false, periodicPullIntervalMs: 0 }
            }
            return { push: true, pull: true, subscribe: true }
        })()

        const wantsSubscribe = modeConfig.subscribe && syncConfig.subscribe !== false
        if (wantsSubscribe && !backend.subscribe && !backend.sse?.buildUrl) {
            throw new Error('[Atoma] sync: subscribe 已启用，但未配置 subscribe 能力（请在 sync.target.http 配置 subscribePath/subscribeUrl/eventSourceFactory，或提供 backend.subscribe）')
        }

        const transport = wantsSubscribe
            ? {
                opsClient: backend.opsClient,
                subscribe: backend.subscribe
                    ? backend.subscribe
                    : (subArgs: { resources?: string[]; onMessage: (msg: any) => void; onError: (error: unknown) => void }) => {
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

        syncEngine = Sync.create({
            transport,
            push: modeConfig.push,
            pull: modeConfig.pull,
            applier,
            outboxKey,
            cursorKey,
            maxQueueSize: syncConfig.maxQueueSize,
            outboxEvents: syncConfig.outboxEvents,
            maxPushItems: syncConfig.maxPushItems,
            pullLimit: syncConfig.pullLimit,
            pullDebounceMs: syncConfig.pullDebounceMs,
            resources: syncConfig.resources,
            returning: syncConfig.returning,
            conflictStrategy: syncConfig.conflictStrategy,
            subscribe: wantsSubscribe,
            reconnectDelayMs: syncConfig.reconnectDelayMs,
            periodicPullIntervalMs: typeof modeConfig.periodicPullIntervalMs === 'number'
                ? modeConfig.periodicPullIntervalMs
                : syncConfig.periodicPullIntervalMs,
            inFlightTimeoutMs: syncConfig.inFlightTimeoutMs,
            retry: syncConfig.retry,
            backoff: syncConfig.backoff,
            lockKey: syncConfig.lockKey,
            lockTtlMs: syncConfig.lockTtlMs,
            lockRenewIntervalMs: syncConfig.lockRenewIntervalMs,
            now: syncConfig.now,
            onError: syncConfig.onError,
            onEvent: syncConfig.onEvent
        })
        engineModeKey = key
        return syncEngine
    }

    // ---------------------------------------------
    // 3) Intent（outbox 写语义）
    // ---------------------------------------------
    const intentController = createSyncIntentController({
        runtime: args.runtime,
        syncConfig,
        ensureSyncEngine: ensureSyncEngine as any
    })

    function buildSubscribeUrl(args2?: { resources?: string[] }): string {
        const backend = args.backend
        if (!backend?.sse?.buildUrl) {
            throw new Error('[Atoma] sync: subscribe 已启用，但未配置 SSE subscribeUrl（请在 sync.target.http 配置 subscribePath/subscribeUrl）')
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
    // 6) Dispose
    // ---------------------------------------------
    const dispose = () => {
        try {
            sync.stop()
        } catch {
            // ignore
        }
        intentController.dispose()
    }

    return {
        sync,
        dispose
    }
}

function withQueryParams(url: string, params: { traceId: string; requestId: string }): string {
    const t = encodeURIComponent(params.traceId)
    const r = encodeURIComponent(params.requestId)
    const join = url.includes('?') ? '&' : '?'
    return `${url}${join}traceId=${t}&requestId=${r}`
}
