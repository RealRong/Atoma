import type { ClientPlugin, ClientPluginContext } from 'atoma-client'
import { DEVTOOLS_REGISTRY_KEY } from 'atoma-client'
import type { SyncBackoffConfig, SyncClient, SyncEvent, SyncMode, SyncPhase, SyncRetryConfig, SyncRuntimeConfig, SyncTransport, SyncDriver, SyncSubscribeDriver } from '#sync/types'
import { SyncEngine } from '#sync/engine/SyncEngine'
import { createStores } from '#sync/storage'
import { WritebackApplier } from '#sync/applier/WritebackApplier'
import { SyncDevtools } from '#sync/devtools/SyncDevtools'
import { SyncPersistHandlers } from '#sync/persistence/SyncPersistHandlers'
import { createOpsSyncDriver } from '#sync/transport'
import { registerSyncDriver, registerSyncSubscribeDriver } from '#sync/capabilities'
import { getOrCreateGlobalReplicaId } from '#sync/internal/replicaId'

export type SyncPluginOptions = Readonly<{
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

    /** Optional sync driver (advanced). */
    driver?: SyncDriver
    /** Optional subscribe driver (advanced). */
    subscribeDriver?: SyncSubscribeDriver
    /** Prefer a specific endpoint id when building ops-based driver (advanced). */
    endpointId?: string
    /** Optional client namespace override for outbox keys. */
    clientKey?: string
}>

export type SyncExtension = Readonly<{
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

export function syncPlugin(opts: SyncPluginOptions = {}): ClientPlugin<SyncExtension> {
    return {
        id: 'sync',
        init: (ctx: ClientPluginContext) => setupSyncPlugin(ctx, opts)
    }
}

function setupSyncPlugin(ctx: ClientPluginContext, opts: SyncPluginOptions): { extension: SyncExtension; dispose: () => void } {
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

    const driver = opts.driver ?? createOpsSyncDriver({
        executeOps: resolveExecuteOps(ctx, opts.endpointId),
        now
    })

    const transport: SyncTransport = driver
    const subscribeTransport = opts.subscribeDriver

    const devtools = new SyncDevtools({ now })
    const unregisterCapability = registerSyncDriver(ctx, driver)
    const unregisterSubscribeCapability = subscribeTransport
        ? registerSyncSubscribeDriver(ctx, subscribeTransport)
        : undefined

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

    const ensureEngine = (m: SyncMode) => {
        if (engine && currentMode === m) return engine
        engine?.dispose()
        currentMode = m
        engine = new SyncEngine(engineConfigForMode(m))
        return engine
    }

    const persistHandlers = new SyncPersistHandlers({ runtime, outbox: stores.outbox })

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

    const extension: SyncExtension = { sync }

    const registry = ctx.capabilities.get<any>(DEVTOOLS_REGISTRY_KEY)
    const unregisterDevtools = registry?.register?.('sync', {
        snapshot: devtools.snapshot,
        subscribe: devtools.subscribe
    })

    const dispose = () => {
        try {
            engine?.dispose()
        } catch {
            // ignore
        }
        engine = null

        try {
            unregisterDevtools?.()
        } catch {
            // ignore
        }

        persistHandlers.dispose()
        try {
            unregisterCapability?.()
        } catch {
            // ignore
        }
        try {
            unregisterSubscribeCapability?.()
        } catch {
            // ignore
        }
    }

    return { extension, dispose }
}

function resolveExecuteOps(ctx: ClientPluginContext, endpointId?: string) {
    if (endpointId) {
        const endpoint = ctx.endpoints.getById(endpointId)
        if (!endpoint || typeof endpoint.driver.executeOps !== 'function') {
            throw new Error(`[Sync] endpoint not found or missing executeOps: ${endpointId}`)
        }
        return (input: { ops: any[]; meta: any; signal?: AbortSignal }) => {
            return endpoint.driver.executeOps(input as any) as any
        }
    }

    const opsEndpoints = ctx.endpoints.getByRole('ops')
    if (opsEndpoints.length && typeof opsEndpoints[0]?.driver?.executeOps === 'function') {
        const driver = opsEndpoints[0]!.driver
        return (input: { ops: any[]; meta: any; signal?: AbortSignal }) => {
            return driver.executeOps(input as any) as any
        }
    }

    return (input: { ops: any[]; meta: any; signal?: AbortSignal }) => {
        return ctx.runtime.io.executeOps({
            ops: input.ops as any,
            ...(input.signal ? { signal: input.signal } : {})
        }).then((results: any) => ({ results })) as any
    }
}
