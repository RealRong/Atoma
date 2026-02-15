import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import type { CommandResult, Source, StreamEvent } from 'atoma-types/devtools'
import { HUB_TOKEN } from 'atoma-types/devtools'
import type { SyncClient, SyncMode, SyncPhase, SyncRuntimeConfig } from 'atoma-types/sync'
import { SyncEngine } from '#sync/engine/sync-engine'
import { createStores } from '#sync/storage'
import { WritebackApplier } from '#sync/applier/writeback-applier'
import { SyncDevtools } from '#sync/devtools/sync-devtools'
import { SyncWrites } from '#sync/persistence/SyncWrites'
import { SYNC_SUBSCRIBE_TRANSPORT_TOKEN, SYNC_TRANSPORT_TOKEN } from '#sync/services'
import { getOrCreateGlobalReplicaId } from '#sync/internal/replica-id'
import type { SyncExtension, SyncPluginOptions } from './types'

export function syncPlugin(opts: SyncPluginOptions = {}): ClientPlugin<SyncExtension> {
    return {
        id: 'sync',
        setup: (ctx: PluginContext) => setupSyncPlugin(ctx, opts)
    }
}

function setupSyncPlugin(ctx: PluginContext, opts: SyncPluginOptions): { extension: SyncExtension; dispose: () => void } {
    const now = opts.now ?? (() => Date.now())
    const modeDefault: SyncMode = opts.mode ?? 'full'
    const resources = opts.resources

    const runtime = ctx.runtime

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
        const driver = ctx.services.resolve(SYNC_TRANSPORT_TOKEN)
        if (!driver) {
            throw new Error('[Sync] sync.transport missing (register via plugin)')
        }
        return driver
    }

    const resolveSubscribeDriver = () => ctx.services.resolve(SYNC_SUBSCRIBE_TRANSPORT_TOKEN)

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
            throw new Error('[Sync] sync.subscribe transport missing (register via plugin)')
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
        const driver = ctx.services.resolve(SYNC_TRANSPORT_TOKEN)
        if (!driver) return false
        const subscribeEnabled = m === 'subscribe-only' || m === 'pull+subscribe' || m === 'full'
        const subscribeEnabledByUser = opts.subscribe !== false
        if (subscribeEnabled && subscribeEnabledByUser && !ctx.services.resolve(SYNC_SUBSCRIBE_TRANSPORT_TOKEN)) {
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

    const syncWrites = new SyncWrites({
        runtime,
        outbox: stores.outbox,
        enqueueRoutes: opts.enqueueRoutes ?? ['direct-local'],
        onEvent,
        onError
    })

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

    const hub = ctx.services.resolve(HUB_TOKEN)
    const sourceId = `sync.${runtime.id}`
    let revision = 0
    const source: Source = {
        spec: {
            id: sourceId,
            clientId: runtime.id,
            namespace: 'sync',
            title: 'Sync',
            priority: 40,
            panels: [
                { id: 'sync', title: 'Sync', order: 40, renderer: 'stats' },
                { id: 'timeline', title: 'Timeline', order: 80, renderer: 'timeline' },
                { id: 'raw', title: 'Raw', order: 999, renderer: 'raw' }
            ],
            capability: {
                snapshot: true,
                stream: true,
                command: true
            },
            tags: ['plugin'],
            commands: [
                { name: 'sync.start', title: 'Start', argsJson: '{"mode":"full"}' },
                { name: 'sync.stop', title: 'Stop' },
                { name: 'sync.pull', title: 'Pull' },
                { name: 'sync.push', title: 'Push' }
            ]
        },
        snapshot: () => {
            const base = devtools.snapshot()
            return {
                version: 1,
                sourceId,
                clientId: runtime.id,
                panelId: 'sync',
                revision,
                timestamp: now(),
                data: {
                    ...base,
                    status: {
                        configured: isConfigured(currentMode),
                        started: base.status?.started ?? devtools.getStarted()
                    }
                }
            }
        },
        subscribe: (emit) => {
            return devtools.subscribe((event: any) => {
                revision += 1
                const timestamp = now()
                const changedEvent: StreamEvent = {
                    version: 1,
                    sourceId,
                    clientId: runtime.id,
                    panelId: 'sync',
                    type: 'data:changed',
                    revision,
                    timestamp
                }
                const timelineEvent: StreamEvent = {
                    version: 1,
                    sourceId,
                    clientId: runtime.id,
                    panelId: 'timeline',
                    type: 'timeline:event',
                    revision,
                    timestamp,
                    payload: event
                }
                emit(changedEvent)
                emit(timelineEvent)
            })
        },
        invoke: async (command): Promise<CommandResult> => {
            try {
                if (command.name === 'sync.start') {
                    const mode = typeof command.args?.mode === 'string' ? command.args.mode as SyncMode : undefined
                    sync.start(mode)
                    return { ok: true }
                }
                if (command.name === 'sync.stop') {
                    sync.stop()
                    return { ok: true }
                }
                if (command.name === 'sync.pull') {
                    await sync.pull()
                    return { ok: true }
                }
                if (command.name === 'sync.push') {
                    await sync.push()
                    return { ok: true }
                }
                return { ok: false, message: `unknown command: ${command.name}` }
            } catch (error) {
                const message = error instanceof Error
                    ? (error.message || 'Unknown error')
                    : String(error ?? 'Unknown error')
                return { ok: false, message }
            }
        }
    }
    const unregisterSource = hub?.register(source)

    const dispose = () => {
        try {
            engine?.dispose()
        } catch {
            // ignore
        }
        engine = null

        try {
            unregisterSource?.()
        } catch {
            // ignore
        }

        syncWrites.dispose()
    }

    return { extension, dispose }
}
