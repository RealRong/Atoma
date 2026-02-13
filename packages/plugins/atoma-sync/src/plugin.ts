import type { RuntimeExtensionContext, RuntimeExtensionPlugin } from 'atoma-types/client/plugins'
import { DEBUG_HUB_CAPABILITY } from 'atoma-types/devtools'
import type { SyncClient, SyncMode, SyncPhase, SyncRuntimeConfig } from 'atoma-types/sync'
import { SyncEngine } from '#sync/engine/sync-engine'
import { createStores } from '#sync/storage'
import { WritebackApplier } from '#sync/applier/writeback-applier'
import { SyncDevtools } from '#sync/devtools/sync-devtools'
import { SyncWrites } from '#sync/persistence/SyncWrites'
import { getSyncDriver, getSyncSubscribeDriver } from '#sync/capabilities'
import { getOrCreateGlobalReplicaId } from '#sync/internal/replica-id'
import type { SyncExtension, SyncPluginOptions } from './types'

export function syncPlugin(opts: SyncPluginOptions = {}): RuntimeExtensionPlugin<SyncExtension> {
    return {
        id: 'sync',
        runtimeExtension: true,
        init: (ctx: RuntimeExtensionContext) => setupSyncPlugin(ctx, opts)
    }
}

function setupSyncPlugin(ctx: RuntimeExtensionContext, opts: SyncPluginOptions): { extension: SyncExtension; dispose: () => void } {
    const now = opts.now ?? (() => Date.now())
    const modeDefault: SyncMode = opts.mode ?? 'full'
    const resources = opts.resources

    const runtime = ctx.runtimeExtension

    const replicaId = getOrCreateGlobalReplicaId({ now })
    const clientKey = String(opts.clientKey ?? runtime.id ?? 'default').trim() || 'default'
    const namespace = `${clientKey}:${replicaId}`
    const keyOutbox = `atoma-sync:${namespace}:outbox`
    const keyCursor = `atoma-sync:${namespace}:cursor`
    const keyLock = `atoma-sync:${namespace}:lock`

    const stores = createStores({
        outboxKey: keyOutbox,
        cursorKey: keyCursor,
        now
    })

    const devtools = new SyncDevtools({ now })
    const resolveDriver = () => {
        const driver = getSyncDriver(ctx)
        if (!driver) {
            throw new Error('[Sync] sync.driver missing (register via plugin)')
        }
        return driver
    }

    const resolveSubscribeDriver = () => getSyncSubscribeDriver(ctx)

    const onEvent = (e: any) => {
        devtools.onEvent(e)
        opts.onEvent?.(e)
    }

    const onError = (error: Error, context: { phase: SyncPhase }) => {
        devtools.onError(error, context)
        opts.onError?.(error, context)
    }

    const applier = new WritebackApplier({
        runtime
    })

    const engineConfigForMode = (m: SyncMode): SyncRuntimeConfig => {
        const transport = resolveDriver()
        const subscribeTransport = resolveSubscribeDriver()

        const pullEnabled = m === 'pull-only' || m === 'pull+subscribe' || m === 'full'
        const subscribeEnabled = m === 'subscribe-only' || m === 'pull+subscribe' || m === 'full'
        const pushEnabled = m === 'push-only' || m === 'full'
        const subscribeEnabledByUser = opts.subscribe !== false

        const pullIntervalMs = Math.max(0, Math.floor(opts.pull?.intervalMs ?? 10_000))
        const pullLimit = 200
        const debounceMs = 300

        const maxItems = Math.max(1, Math.floor(opts.push?.maxItems ?? 50))
        const returning = false

        const reconnectDelayMs = Math.max(200, Math.floor(
            (typeof opts.subscribe === 'object' && opts.subscribe ? opts.subscribe.reconnectDelayMs : undefined) ?? 1000
        ))

        const retry = opts.policy?.retry ?? {}
        const backoff = opts.policy?.backoff ?? {}

        if (subscribeEnabled && subscribeEnabledByUser && !subscribeTransport) {
            throw new Error('[Sync] sync.subscribe missing (register via plugin)')
        }

        return {
            transport,
            applier,
            outbox: stores.outbox,
            cursor: stores.cursor,

            push: {
                enabled: pushEnabled,
                maxItems,
                returning,
                retry,
                backoff
            },

            pull: {
                enabled: pullEnabled,
                limit: pullLimit,
                debounceMs,
                ...(resources?.length ? { resources } : {}),
                periodic: {
                    intervalMs: pullIntervalMs,
                    retry,
                    backoff
                }
            },

            subscribe: {
                enabled: Boolean(subscribeTransport) && subscribeEnabled && subscribeEnabledByUser,
                reconnectDelayMs,
                retry,
                backoff
            },

            lock: {
                key: keyLock,
                backoff
            },

            now,
            onEvent,
            onError,
            ...(subscribeTransport ? { subscribeTransport } : {})
        }
    }

    let currentMode: SyncMode = modeDefault
    let engine: SyncClient | null = null

    const isConfigured = (m: SyncMode) => {
        const driver = getSyncDriver(ctx)
        if (!driver) return false
        const subscribeEnabled = m === 'subscribe-only' || m === 'pull+subscribe' || m === 'full'
        const subscribeEnabledByUser = opts.subscribe !== false
        if (subscribeEnabled && subscribeEnabledByUser && !getSyncSubscribeDriver(ctx)) {
            return false
        }
        return true
    }

    const ensureEngine = (m: SyncMode) => {
        if (engine && currentMode === m) return engine
        engine?.dispose()
        currentMode = m
        engine = new SyncEngine(engineConfigForMode(m))
        return engine
    }

    const syncWrites = new SyncWrites({ runtime, outbox: stores.outbox })

    const sync = {
        start: (m?: SyncMode) => {
            const selected = m ?? modeDefault
            ensureEngine(selected).start()
        },
        stop: () => {
            engine?.stop()
        },
        dispose: () => {
            engine?.dispose()
            engine = null
        },
        status: () => {
            return { started: devtools.getStarted(), configured: isConfigured(currentMode) }
        },
        pull: async () => {
            const e = ensureEngine(currentMode)
            await e.pull()
        },
        push: async () => {
            const e = ensureEngine(currentMode)
            await e.push()
        },
        devtools: {
            snapshot: devtools.snapshot,
            subscribe: devtools.subscribe
        }
    } as const

    const extension: SyncExtension = { sync }

    const debugHub = ctx.capabilities.get(DEBUG_HUB_CAPABILITY)
    const syncProviderId = `sync.${runtime.id}`
    const unregisterDebugProvider = debugHub?.register({
        id: syncProviderId,
        kind: 'sync',
        clientId: runtime.id,
        priority: 40,
        snapshot: () => {
            const base = devtools.snapshot()
            return {
                version: 1,
                providerId: syncProviderId,
                kind: 'sync',
                clientId: runtime.id,
                timestamp: now(),
                scope: { tab: 'sync' },
                data: {
                    ...base,
                    status: {
                        configured: isConfigured(currentMode),
                        started: base.status?.started ?? devtools.getStarted()
                    }
                }
            }
        }
    })

    const dispose = () => {
        try {
            engine?.dispose()
        } catch {
            // ignore
        }
        engine = null

        try {
            unregisterDebugProvider?.()
        } catch {
            // ignore
        }

        syncWrites.dispose()
    }

    return { extension, dispose }
}
