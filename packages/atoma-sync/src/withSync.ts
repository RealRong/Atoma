import type { ClientPlugin, ClientPluginContext, PluginCapableClient } from 'atoma/client'
import type { SyncClient, SyncMode, SyncOutboxEvents, SyncOutboxStats, SyncPhase, SyncRuntimeConfig, SyncSubscribe, SyncTransport } from '#sync/types'
import { SyncEngine } from '#sync/engine/SyncEngine'
import { createOpsTransport } from '#sync/transport/opsTransport'
import { createStores } from '#sync/store'
import { Protocol } from 'atoma/protocol'
import { WritebackApplier } from './applier/WritebackApplier'
import { registerSyncPersistHandlers } from './persistence/registerPersistHandlers'

export type WithSyncOptions = Readonly<{
    mode?: SyncMode
    resources?: string[]

    outbox?: false | Readonly<{
        mode?: 'queue' | 'local-first'
        storage?: Readonly<{ maxSize?: number; inFlightTimeoutMs?: number }>
        events?: SyncOutboxEvents
    }>

    state?: Readonly<{
        deviceId?: string
        keys?: Readonly<{ outbox?: string; cursor?: string; lock?: string }>
        lock?: Readonly<{ ttlMs?: number; renewIntervalMs?: number }>
    }>

    engine?: Readonly<{
        pull?: Readonly<{ limit?: number; debounceMs?: number; intervalMs?: number }>
        push?: Readonly<{ maxItems?: number; returning?: boolean; conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual' }>
        subscribe?: Readonly<{ enabled?: boolean; reconnectDelayMs?: number }>
        retry?: Readonly<{ maxAttempts?: number }>
        backoff?: Readonly<{ baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }>
        now?: () => number
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: any) => void
    }>

    /**
     * Durable mirror persistence (optional).
     * - When enabled, pull/ack/reject results are also written to a durable backend (local-first).
     * - Default: 'auto' (when `ctx.meta.storeBackend.role === 'local'`, uses `ctx.runtime.opsClient` as mirror).
     */
    mirror?: 'auto' | false | Readonly<{ opsClient: { executeOps: (input: any) => Promise<any> } }>

    /** Whether to attach `store.Outbox` view by patching `client.Store(name)`. Default: true. */
    attachOutboxView?: boolean
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
    return client.use(syncPlugin(opts)) as any
}

export function syncPlugin(opts: WithSyncOptions): ClientPlugin<WithSyncExtension> {
    return {
        name: 'sync',
        setup: (ctx) => setupSyncPlugin(ctx, opts)
    }
}

function setupSyncPlugin(ctx: ClientPluginContext, opts: WithSyncOptions): { extension: WithSyncExtension; dispose: () => void } {
    const client: any = ctx.client as any

    const now = opts.engine?.now ?? (() => Date.now())
    const modeDefault: SyncMode = opts.mode ?? 'full'
    const resources = opts.resources

    const deviceId = String(opts.state?.deviceId ?? defaultDeviceId())
    const keys = opts.state?.keys ?? {}
    const keyOutbox = String(keys.outbox ?? `atoma-sync:${deviceId}:outbox`)
    const keyCursor = String(keys.cursor ?? `atoma-sync:${deviceId}:cursor`)
    const keyLock = String(keys.lock ?? `atoma-sync:${deviceId}:lock`)

    const outboxCfg = opts.outbox
    const outboxEnabled = outboxCfg !== false
    const outboxConfig = outboxCfg === false ? {} : (outboxCfg ?? {})
    const outboxMode = outboxConfig.mode === 'local-first' ? 'local-first' : 'queue'

    const stores = createStores({
        outboxKey: keyOutbox,
        cursorKey: keyCursor,
        queueEnabled: outboxEnabled,
        queueMode: outboxMode,
        maxQueueSize: outboxEnabled ? (outboxConfig.storage?.maxSize ?? 1000) : 0,
        inFlightTimeoutMs: outboxEnabled ? (outboxConfig.storage?.inFlightTimeoutMs ?? 30_000) : undefined,
        outboxEvents: outboxEnabled ? outboxConfig.events : undefined,
        now
    })

    // Remote I/O is provided by the client runtime (ctx.io) so that other plugins can intercept it.
    const remoteOpsClient = {
        executeOps: (input: any) => ctx.io.executeOps({
            channel: 'remote',
            ops: input.ops,
            meta: input.meta,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.context ? { context: input.context } : {})
        }) as any
    }

    const remoteSubscribe: SyncSubscribe | undefined = ctx.io.subscribe
        ? ((args) => ctx.io.subscribe!({
            channel: 'remote',
            resources: args.resources,
            signal: args.signal,
            onError: args.onError,
            onMessage: (raw) => {
                try {
                    if (typeof raw === 'string') {
                        args.onMessage(Protocol.sse.parse.notifyMessage(raw))
                        return
                    }
                    // If the I/O layer already decoded a structured message, accept it.
                    if (raw && typeof raw === 'object') {
                        const resources2 = (raw as any).resources
                        const traceId = (raw as any).traceId
                        args.onMessage({
                            ...(Array.isArray(resources2) ? { resources: resources2.map((r: any) => String(r)) } : {}),
                            ...(typeof traceId === 'string' ? { traceId } : {})
                        })
                        return
                    }
                    throw new Error('[atoma-sync] notify message: unsupported payload')
                } catch (error) {
                    args.onError(error)
                }
            }
        }))
        : undefined

    const transport: SyncTransport = createOpsTransport({
        opsClient: remoteOpsClient as any,
        ...(remoteSubscribe ? { subscribe: remoteSubscribe as any } : {}),
        now
    })

    const devtoolsSubscribers = new Set<(e: any) => void>()
    const emitDevtools = (e: any) => {
        for (const fn of devtoolsSubscribers) {
            try {
                fn(e)
            } catch {
                // ignore
            }
        }
    }

    let lastEventAt: number | undefined
    let lastError: string | undefined
    let lastOutboxStats: SyncOutboxStats | undefined
    let started = false

    const onEvent = (e: any) => {
        lastEventAt = now()
        if (e?.type === 'outbox:queue') lastOutboxStats = e.stats
        if (e?.type === 'outbox:queue_full') lastOutboxStats = e.stats
        if (e?.type === 'lifecycle:started') started = true
        if (e?.type === 'lifecycle:stopped') started = false
        emitDevtools({ type: String(e?.type ?? 'event'), payload: e })
        opts.engine?.onEvent?.(e)
    }

    const onError = (error: Error, context: { phase: SyncPhase }) => {
        lastError = error?.message ? String(error.message) : 'Unknown error'
        emitDevtools({ type: 'error', payload: { error: lastError, context } })
        opts.engine?.onError?.(error, context)
    }

    const mirrorMode = opts.mirror ?? 'auto'
    const mirrorOpsClient = mirrorMode === false
        ? undefined
        : (mirrorMode === 'auto')
            ? (ctx.meta?.storeBackend?.role === 'local' ? (ctx.runtime.opsClient as any) : undefined)
            : (mirrorMode.opsClient as any)

    const applier = new WritebackApplier({
        ctx,
        remoteOpsClient: remoteOpsClient as any,
        ...(mirrorOpsClient ? { mirrorOpsClient } : {}),
        conflictStrategy: opts.engine?.push?.conflictStrategy,
        now
    })

    const engineConfigForMode = (m: SyncMode): SyncRuntimeConfig => {
        const pullEnabled = m === 'pull-only' || m === 'pull+subscribe' || m === 'full'
        const subscribeEnabled = m === 'subscribe-only' || m === 'pull+subscribe' || m === 'full'
        const pushEnabled = m === 'push-only' || m === 'full'
        const subscribeEnabledByUser = opts.engine?.subscribe?.enabled

        const pullIntervalMs = Math.max(0, Math.floor(opts.engine?.pull?.intervalMs ?? 10_000))
        const pullLimit = Math.max(1, Math.floor(opts.engine?.pull?.limit ?? 200))
        const debounceMs = Math.max(0, Math.floor(opts.engine?.pull?.debounceMs ?? 300))

        const maxItems = Math.max(1, Math.floor(opts.engine?.push?.maxItems ?? 50))
        const returning = Boolean(opts.engine?.push?.returning ?? false)

        const reconnectDelayMs = Math.max(200, Math.floor(opts.engine?.subscribe?.reconnectDelayMs ?? 1000))

        const retry = opts.engine?.retry ?? {}
        const backoff = opts.engine?.backoff ?? {}

        return {
            transport,
            applier,
            ...(stores.outbox ? { outbox: stores.outbox } : {}),
            cursor: stores.cursor,
            ...(stores.outbox ? { outboxEvents: outboxEnabled ? outboxConfig.events : undefined } : {}),

            push: {
                enabled: pushEnabled && Boolean(stores.outbox),
                maxItems,
                returning,
                ...(opts.engine?.push?.conflictStrategy ? { conflictStrategy: opts.engine.push.conflictStrategy } : {}),
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
                enabled: Boolean(remoteSubscribe) && subscribeEnabled && subscribeEnabledByUser !== false,
                reconnectDelayMs,
                retry,
                backoff
            },

            lock: {
                key: keyLock,
                ttlMs: opts.state?.lock?.ttlMs,
                renewIntervalMs: opts.state?.lock?.renewIntervalMs,
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
    const unregister: Array<() => void> = (outboxEnabled && stores.outbox)
        ? registerSyncPersistHandlers({ ctx, outbox: stores.outbox })
        : []

    // Optional: attach store view for queued writes.
    const originalStoreFn = typeof client?.Store === 'function' ? client.Store.bind(client) : null
    const attachOutboxView = opts.attachOutboxView !== false
    if (attachOutboxView && originalStoreFn && ctx.stores?.view && outboxEnabled) {
        const persistKey = outboxMode === 'local-first' ? 'sync:local-first' : 'sync:queue'
        const allowImplicitFetchForWrite = outboxMode === 'queue' ? false : undefined

        client.Store = (name: string) => {
            const base = originalStoreFn(name)
            if (base && typeof base === 'object' && !('Outbox' in base)) {
                try {
                    Object.defineProperty(base, 'Outbox', {
                        enumerable: false,
                        configurable: true,
                        get: () => ctx.stores!.view(base, {
                            persistKey,
                            allowImplicitFetchForWrite,
                            includeServerAssignedCreate: false
                        })
                    })
                } catch {
                    ;(base as any).Outbox = ctx.stores!.view(base, {
                        persistKey,
                        allowImplicitFetchForWrite,
                        includeServerAssignedCreate: false
                    })
                }
            }
            return base
        }
    }

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
            return { started, configured: true }
        },
        pull: async () => {
            const e = ensureEngine(currentMode)
            await e.pull()
        },
        push: async () => {
            const e = ensureEngine(currentMode)
            await e.flush()
        },
        devtools: {
            snapshot: () => ({
                status: { configured: true, started },
                ...(lastOutboxStats ? { queue: { pending: lastOutboxStats.pending, inFlight: lastOutboxStats.inFlight, total: lastOutboxStats.total } } : {}),
                lastEventAt,
                lastError
            }),
            subscribe: (fn: (e: any) => void) => {
                devtoolsSubscribers.add(fn)
                return () => {
                    devtoolsSubscribers.delete(fn)
                }
            }
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

        for (let i = unregister.length - 1; i >= 0; i--) {
            try {
                unregister[i]!()
            } catch {
                // ignore
            }
        }

        if (originalStoreFn) {
            try {
                client.Store = originalStoreFn
            } catch {
                // ignore
            }
        }
    }

    ctx.onDispose(dispose)

    return { extension, dispose }
}

function defaultDeviceId(): string {
    const cryptoAny = (globalThis as any)?.crypto
    const uuid = cryptoAny?.randomUUID?.bind(cryptoAny)
    if (typeof uuid === 'function') {
        try {
            return String(uuid())
        } catch {
            // ignore
        }
    }
    return `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
}
