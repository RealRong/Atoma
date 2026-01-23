import type { CoreStore, Entity, StoreDataProcessor } from '#core'
import { createStoreView } from '#core/store/createStoreView'
import { storeHandleManager } from '#core/store/internals/storeHandleManager'
import { HistoryController } from '#client/internal/controllers/HistoryController'
import { ClientRuntime } from '#client/internal/factory/runtime/createClientRuntime'
import { Protocol } from '#protocol'
import type {
    AtomaClient,
    AtomaSchema,
    BackendEndpointConfig,
    StoreBackendState,
    StoreBatchArgs,
} from '#client/types'
import { resolveBackend } from '#client/internal/factory/backend/resolveBackend'
import { Devtools } from '#devtools'

export function buildAtomaClient<
    const Entities extends Record<string, Entity>,
    const Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
>(args: {
    schema: Schema
    dataProcessor?: StoreDataProcessor<any>
    storeBackendState: StoreBackendState
    remoteBackend?: BackendEndpointConfig
    storeBatch?: StoreBatchArgs
}): AtomaClient<Entities, Schema> {
    const storeBackendState = args.storeBackendState
    // NOTE: resolveBackend cannot infer local/remote roles; we wire it based on storeBackendState.role.
    const resolvedStore = (storeBackendState.role === 'local')
        ? resolveBackend({
            local: storeBackendState.backend,
            ...(args.remoteBackend ? { remote: args.remoteBackend } : {})
        } as any)
        : resolveBackend(storeBackendState.backend as any)

    const storeBackend = resolvedStore.store
    // When Store backend is remote, still allow an explicit `remote` channel override.
    const remoteBackend = (storeBackendState.role === 'remote' && args.remoteBackend)
        ? (() => {
            const resolvedRemote = resolveBackend(args.remoteBackend as any)
            return resolvedRemote.remote ?? resolvedRemote.store
        })()
        : resolvedStore.remote
    const clientKey = String(remoteBackend?.key ?? storeBackend.key)

    // Build an I/O pipeline (middleware chain) shared by Store and extension packages.
    const baseExecuteOps = async (req: import('#client/types').IoExecuteOpsRequest): Promise<import('#client/types').IoExecuteOpsResponse> => {
        if (req.channel === 'store') {
            return await storeBackend.opsClient.executeOps({
                ops: req.ops as any,
                meta: req.meta as any,
                ...(req.signal ? { signal: req.signal } : {}),
                ...(req.context ? { context: req.context } : {})
            }) as any
        }
        if (!remoteBackend) {
            throw new Error('[Atoma] io: remote backend 未配置（createClient({ remote })）')
        }
        return await remoteBackend.opsClient.executeOps({
            ops: req.ops as any,
            meta: req.meta as any,
            ...(req.signal ? { signal: req.signal } : {}),
            ...(req.context ? { context: req.context } : {})
        }) as any
    }

    const ioMiddlewares: Array<import('#client/types').IoMiddleware> = []

    const composeIo = () => {
        let handler: import('#client/types').IoHandler = baseExecuteOps
        for (let i = ioMiddlewares.length - 1; i >= 0; i--) {
            handler = ioMiddlewares[i]!(handler)
        }
        return handler
    }

    let ioExecute: import('#client/types').IoHandler = composeIo()

    const clientRuntime = new ClientRuntime({
        schema: args.schema,
        dataProcessor: args.dataProcessor,
        // Important: all store ops go through the I/O pipeline (`channel: 'store'`).
        opsClient: {
            executeOps: (input: any) => ioExecute({
                channel: 'store',
                ops: input.ops,
                meta: input.meta,
                ...(input.signal ? { signal: input.signal } : {}),
                ...(input.context ? { context: input.context } : {})
            }) as any
        }
    })

    const historyController = new HistoryController({ runtime: clientRuntime })

    const Store = (<Name extends keyof Entities & string>(
        name: Name,
        options?: { writeStrategy?: import('#core').WriteStrategy }
    ) => {
        const store: any = clientRuntime.stores.Store(name) as any
        const writeStrategy = options?.writeStrategy
        if (!writeStrategy) {
            return store as unknown as CoreStore<Entities[Name], any>
        }

        const handle = storeHandleManager.requireStoreHandle(store as any, `client.Store:${String(name)}`)
        const allowImplicitFetchForWrite = (writeStrategy === 'queue') ? false : true

        return createStoreView(clientRuntime as any, handle as any, {
            writeConfig: {
                writeStrategy,
                allowImplicitFetchForWrite
            },
            includeServerAssignedCreate: writeStrategy === 'direct'
        }) as unknown as CoreStore<Entities[Name], any>
    }) as AtomaClient<Entities, Schema>['Store']

    const client: any = {
        Store,
        History: historyController.history
    }

    const kind = (() => {
        const b: any = storeBackendState.backend
        if (typeof b === 'string') return 'http' as const
        if (b && typeof b === 'object' && !Array.isArray(b)) {
            if ('indexeddb' in b) return 'indexeddb' as const
            if ('memory' in b) return 'memory' as const
            if ('opsClient' in b) return 'custom' as const
            if ('http' in b) return (storeBackendState.role === 'local' ? 'localServer' : 'http') as 'localServer' | 'http'
        }
        return 'custom' as const
    })()

    // Plugin system (core is intentionally sync-agnostic).
    const installed = new Set<string>()
    const pluginDisposers: Array<() => void> = []
    const disposeListeners = new Set<() => void>()

    const onDispose = (fn: () => void) => {
        disposeListeners.add(fn)
        return () => {
            disposeListeners.delete(fn)
        }
    }

    const ctx: import('#client/types').ClientPluginContext = {
        client,
        meta: {
            clientKey,
            storeBackend: {
                role: storeBackendState.role,
                kind
            }
        },
        onDispose,
        io: {
            executeOps: (req) => ioExecute(req),
            use: (mw) => {
                ioMiddlewares.push(mw)
                ioExecute = composeIo()
                return () => {
                    const idx = ioMiddlewares.indexOf(mw)
                    if (idx >= 0) ioMiddlewares.splice(idx, 1)
                    ioExecute = composeIo()
                }
            },
            ...(remoteBackend?.sse
                ? {
                    subscribe: (req) => {
                        if (req.channel !== 'remote') {
                            throw new Error('[Atoma] io.subscribe: only channel=\"remote\" is supported')
                        }
                        const buildUrl = remoteBackend.sse!.buildUrl
                        const connect = remoteBackend.sse!.connect
                        const url = buildUrl({ resources: req.resources })

                        let es: EventSource
                        if (connect) es = connect(url)
                        else if (typeof EventSource !== 'undefined') es = new EventSource(url)
                        else throw new Error('[Atoma] io.subscribe: EventSource not available and no connect provided')

                        const eventName = Protocol.sse.events.NOTIFY

                        es.addEventListener(eventName, (event: any) => {
                            try {
                                req.onMessage(String(event.data))
                            } catch (err) {
                                req.onError(err)
                            }
                        })
                        es.onerror = (err) => {
                            req.onError(err)
                        }

                        if (req.signal) {
                            const signal = req.signal
                            if (signal.aborted) {
                                try { es.close() } catch {}
                            } else {
                                const onAbort = () => {
                                    try { es.close() } catch {}
                                }
                                signal.addEventListener('abort', onAbort, { once: true })
                            }
                        }

                        return { close: () => es.close() }
                    }
                }
                : {})
        },
        persistence: {
            register: clientRuntime.persistenceRouter.register
        },
        acks: clientRuntime.mutation.acks,
        writeback: {
            apply: (storeName, writeback) => clientRuntime.internal.applyWriteback(String(storeName), writeback as any)
        },
        stores: {
            view: (store, args2) => {
                const name = storeHandleManager.getStoreName(store as any, 'plugin.view')
                const handle = storeHandleManager.requireStoreHandle(store as any, `plugin.view:${name}`)
                const allowImplicitFetchForWrite = (typeof args2.allowImplicitFetchForWrite === 'boolean')
                    ? args2.allowImplicitFetchForWrite
                    : (args2.writeStrategy === 'queue' ? false : true)

                return createStoreView(clientRuntime as any, handle as any, {
                    writeConfig: {
                        writeStrategy: args2.writeStrategy,
                        allowImplicitFetchForWrite
                    },
                    includeServerAssignedCreate: args2.includeServerAssignedCreate !== false
                }) as any
            }
        },
        runtime: {
            opsClient: clientRuntime.opsClient,
            observability: clientRuntime.observability
        }
    }

    client.use = (plugin: any) => {
        const name = String(plugin?.name ?? '')
        if (!name) throw new Error('[Atoma] client.use(plugin): plugin.name 必填')
        if (installed.has(name)) return client
        installed.add(name)

        const res = plugin.setup(ctx) ?? {}
        const extension = res.extension
        if (extension && typeof extension === 'object') {
            for (const [k, v] of Object.entries(extension)) {
                if (k in client) throw new Error(`[Atoma] client.use(${name}): extension 冲突字段 "${k}"`)
                ;(client as any)[k] = v
            }
        }

        if (typeof res.dispose === 'function') {
            pluginDisposers.push(res.dispose)
        }

        return client
    }

    let disposed = false
    client.dispose = () => {
        if (disposed) return
        disposed = true

        for (let i = pluginDisposers.length - 1; i >= 0; i--) {
            try {
                pluginDisposers[i]!()
            } catch {
                // ignore
            }
        }

        for (const fn of Array.from(disposeListeners)) {
            try {
                fn()
            } catch {
                // ignore
            }
        }

        try {
            client.Devtools?.dispose?.()
        } catch {
            // ignore
        }
    }

    const clientDevtools = Devtools.createClientInspector({
        client,
        runtime: clientRuntime,
        historyDevtools: historyController.devtools,
        meta: {
            storeBackend: {
                role: storeBackendState.role,
                kind
            },
        }
    })

    client.Devtools = clientDevtools

    return client as AtomaClient<Entities, Schema>
}
