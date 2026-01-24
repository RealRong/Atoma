import type { ClientPlugin, ClientPluginContext, PluginCapableClient } from 'atoma/client'
import type { SyncBackoffConfig, SyncClient, SyncEvent, SyncMode, SyncPhase, SyncRetryConfig, SyncRuntimeConfig, SyncSubscribe, SyncTransport } from '#sync/types'
import { SyncEngine } from '#sync/engine/SyncEngine'
import { createStores } from '#sync/storage'
import { WritebackApplier } from '#sync/applier/WritebackApplier'
import { SyncDevtools } from '#sync/devtools/SyncDevtools'
import { SyncPersistHandlers } from '#sync/persistence/SyncPersistHandlers'
import { RemoteTransport } from '#sync/transport/RemoteTransport'
import { getOrCreateGlobalReplicaId } from '#sync/internal/replicaId'

export type WithSyncOptions = Readonly<{
    mode?: SyncMode
    resources?: string[]

    pull?: Readonly<{ intervalMs?: number }>
    push?: Readonly<{ maxItems?: number }>
    subscribe?: boolean | Readonly<{ reconnectDelayMs?: number }>

    policy?: Readonly<{
        retry?: SyncRetryConfig
        backoff?: SyncBackoffConfig
    }>

    now?: () => number
    onError?: (error: Error, context: { phase: SyncPhase }) => void
    onEvent?: (event: SyncEvent) => void
}>

export type WithSyncExtension = Readonly<{
    sync: {
        start: (mode?: SyncMode) => void
        stop: () => void
        dispose: () => void
        status: () => { started: boolean; configured: boolean }
        pull: () => Promise<void>
        push: () => Promise<void>
        devtools: { snapshot: () => any; subscribe: (fn: (e: any) => void) => () => void }
    }
}>

export function withSync<TClient extends PluginCapableClient>(client: TClient, opts: WithSyncOptions): TClient & WithSyncExtension {
    return client.use(syncPlugin(opts))
}

export function syncPlugin(opts: WithSyncOptions): ClientPlugin<WithSyncExtension> {
    return {
        name: 'sync',
        setup: (ctx) => setupSyncPlugin(ctx, opts)
    }
}

function setupSyncPlugin(ctx: ClientPluginContext, opts: WithSyncOptions): { extension: WithSyncExtension; dispose: () => void } {
    const now = opts.now ?? (() => Date.now())
    const modeDefault: SyncMode = opts.mode ?? 'full'
    const resources = opts.resources

    const replicaId = getOrCreateGlobalReplicaId({ now })
    const clientKey = String(ctx.meta?.clientKey ?? 'default').trim() || 'default'
    const namespace = `${clientKey}:${replicaId}`
    const keyOutbox = `atoma-sync:${namespace}:outbox`
    const keyCursor = `atoma-sync:${namespace}:cursor`
    const keyLock = `atoma-sync:${namespace}:lock`

    // Outbox is always enabled. Users can control scheduling via `sync.start()`/`sync.push()`
    // and lane config (e.g. `mode: 'pull-only'`), but the persistence model stays uniform.
    const stores = createStores({
        outboxKey: keyOutbox,
        cursorKey: keyCursor,
        now
    })

    const transport: SyncTransport = new RemoteTransport(ctx)
    const remoteSubscribe: SyncSubscribe | undefined = transport.subscribe

    const devtools = new SyncDevtools({ now })

    const onEvent = (e: any) => {
        devtools.onEvent(e)
        opts.onEvent?.(e)
    }

    const onError = (error: Error, context: { phase: SyncPhase }) => {
        devtools.onError(error, context)
        opts.onError?.(error, context)
    }

    const applier = new WritebackApplier({
        ctx
    })

    const engineConfigForMode = (m: SyncMode): SyncRuntimeConfig => {
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
                enabled: Boolean(remoteSubscribe) && subscribeEnabled && subscribeEnabledByUser,
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
            onError
        }
    }

    let currentMode: SyncMode = modeDefault
    let engine: SyncClient | null = null

    const ensureEngine = (m: SyncMode) => {
        if (engine && currentMode === m) return engine
        engine?.dispose()
        currentMode = m
        engine = new SyncEngine(engineConfigForMode(m))
        return engine
    }

    // Register persist handlers for the outbox store views.
    const persistHandlers = new SyncPersistHandlers({ ctx, outbox: stores.outbox })

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
            return { started: devtools.getStarted(), configured: true }
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

    const extension: WithSyncExtension = { sync }

    const dispose = () => {
        try {
            engine?.dispose()
        } catch {
            // ignore
        }
        engine = null

        persistHandlers.dispose()
    }

    ctx.onDispose(dispose)

    return { extension, dispose }
}
