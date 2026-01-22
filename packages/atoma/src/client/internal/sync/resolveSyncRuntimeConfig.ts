import { Sync, wantsPush, wantsSubscribe, createOpsTransport, type CursorStore, type OutboxReader, type SyncApplier, type SyncRuntimeConfig, type SyncTransport } from 'atoma-sync'
import type { AtomaClientSyncConfig, AtomaSyncStartMode, ResolvedBackend } from '#client/types'
import type { ClientRuntimeSseTransport } from '#client/internal/sync/ClientRuntimeSseTransport'
import type { ClientRuntimeSyncDiagnostics } from '#client/internal/sync/ClientRuntimeSyncDiagnostics'

type EngineMode = AtomaSyncStartMode

export function resolveSyncRuntimeConfig(args: {
    mode: EngineMode
    syncConfig: AtomaClientSyncConfig
    backend: ResolvedBackend
    applier: SyncApplier
    outboxStore?: OutboxReader
    cursorStore?: CursorStore
    lockKey?: string
    now?: () => number
    diagnostics: ClientRuntimeSyncDiagnostics
    sseTransport?: ClientRuntimeSseTransport
}): SyncRuntimeConfig {
    const syncConfig = args.syncConfig
    const backend = args.backend

    const eng = syncConfig.engine

    const cursorStore = args.cursorStore
    if (!cursorStore) {
        throw new Error('[Atoma] sync: 未配置 cursor store（内部错误：createClient 未创建 cursor store）')
    }

    const pushEnabled = wantsPush(args.mode)
    const pullEnabled = args.mode !== 'push-only'

    const subscribeEnabled = wantsSubscribe(args.mode)
        && eng.subscribe.enabled !== false

    if (pushEnabled && !args.outboxStore) {
        throw new Error('[Atoma] sync: push 模式需要配置 outbox（请在 createClient 中启用 outbox）')
    }

    const now = args.now ?? eng.now ?? (() => Date.now())

    const transport: SyncTransport = resolveTransport({
        backend,
        subscribeEnabled,
        now,
        subscribe: {
            eventName: eng.subscribe.eventName,
            sseTransport: args.sseTransport
        }
    })

    const retry = eng.retry ?? { maxAttempts: 10 }
    const resolveBackoff = (fallback: { baseDelayMs: number }) => ({
        baseDelayMs: fallback.baseDelayMs,
        maxDelayMs: 30_000,
        jitterRatio: 0.2,
        ...(eng.backoff ?? {})
    })

    const reconnectDelayMs = Math.max(0, Math.floor(eng.subscribe.reconnectDelayMs ?? 1000))
    const pullIntervalMs = pullEnabled
        ? Math.max(0, Math.floor(args.mode === 'subscribe-only' ? 0 : (eng.pull.intervalMs ?? 30_000)))
        : 0

    const pullBackoffBaseDelayMs = Math.max(0, Math.floor(eng.pull.intervalMs ?? 1_000))
    const lockBackoffBaseDelayMs = Math.max(0, Math.floor(eng.subscribe.reconnectDelayMs ?? 300))

    const lockKey = syncConfig.state.keys.lock ?? args.lockKey
    if (!lockKey) {
        throw new Error('[Atoma] sync: 未配置 lockKey（内部错误：createClient 未提供 lockKey）')
    }

    return {
        transport,
        applier: args.applier,
        outbox: args.outboxStore,
        cursor: cursorStore,
        outboxEvents: syncConfig.outbox !== false ? syncConfig.outbox.events : undefined,

        push: {
            enabled: pushEnabled,
            maxItems: Math.max(1, Math.floor(eng.push.maxItems ?? 50)),
            returning: eng.push.returning !== false,
            conflictStrategy: eng.push.conflictStrategy as any,
            retry: retry as any,
            backoff: resolveBackoff({ baseDelayMs: 300 }) as any
        },

        pull: {
            enabled: pullEnabled,
            limit: Math.max(1, Math.floor(eng.pull.limit ?? 200)),
            debounceMs: Math.max(0, Math.floor(eng.pull.debounceMs ?? 200)),
            resources: eng.resources,
            initialCursor: eng.initialCursor as any,
            periodic: {
                intervalMs: pullIntervalMs,
                retry: retry as any,
                backoff: resolveBackoff({ baseDelayMs: pullBackoffBaseDelayMs }) as any
            }
        },

        subscribe: {
            enabled: subscribeEnabled,
            reconnectDelayMs,
            retry: retry as any,
            backoff: resolveBackoff({ baseDelayMs: reconnectDelayMs }) as any
        },

        lock: {
            key: lockKey,
            ttlMs: syncConfig.state.lock.ttlMs,
            renewIntervalMs: syncConfig.state.lock.renewIntervalMs,
            backoff: resolveBackoff({ baseDelayMs: lockBackoffBaseDelayMs }) as any
        },
        now,
        onError: args.diagnostics.wrapOnError(eng.onError),
        onEvent: args.diagnostics.wrapOnEvent(eng.onEvent)
    }
}

function resolveTransport(args: {
    backend: ResolvedBackend
    subscribeEnabled: boolean
    now: () => number
    subscribe: {
        eventName?: string
        sseTransport?: ClientRuntimeSseTransport
    }
}): SyncTransport {
    const backend = args.backend

    if (!args.subscribeEnabled) {
        return createOpsTransport({ opsClient: backend.opsClient, now: args.now })
    }

    if (!backend.sse?.buildUrl) {
        throw new Error('[Atoma] sync: subscribe 已启用，但未配置 SSE buildUrl（请配置 sync.sse 或 sync.endpoint.sse）')
    }

    const sseTransport = args.subscribe.sseTransport ?? { buildUrl: backend.sse.buildUrl }
    return createOpsTransport({
        opsClient: backend.opsClient,
        now: args.now,
        subscribe: (subArgs) => {
            return Sync.subscribeNotifySse({
                resources: subArgs.resources,
                buildUrl: (a) => sseTransport.buildUrl(a),
                connect: backend.sse?.connect,
                eventName: args.subscribe.eventName,
                onMessage: subArgs.onMessage,
                onError: subArgs.onError
            })
        }
    })
}
