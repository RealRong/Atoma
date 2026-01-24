import type { CoreStore, Entity, PersistWriteback, StoreDataProcessor, StoreToken } from '#core'
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
import type { ObservabilityContext } from '#observability'

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
    const baseExecuteOps = async (req: import('#client/types').IoRequest): Promise<import('#client/types').IoResponse> => {
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

    type Operation = import('#protocol').Operation
    type OperationResult = import('#protocol').OperationResult
    type QueryParams = import('#protocol').QueryParams
    type WriteAction = import('#protocol').WriteAction
    type WriteItem = import('#protocol').WriteItem
    type WriteOptions = import('#protocol').WriteOptions
    type WriteResultData = import('#protocol').WriteResultData
    type ChangeBatch = import('#protocol').ChangeBatch
    type Cursor = import('#protocol').Cursor

    const now = () => Date.now()

    function requireResultByOpId(results: OperationResult[], opId: string, missingMessage: string): OperationResult {
        for (const r of results) {
            if ((r as any)?.opId === opId) return r
        }
        throw new Error(missingMessage)
    }

    function toOpsError(result: OperationResult, tag: string): Error {
        if ((result as any).ok) return new Error(`[${tag}] Operation failed`)
        const message = ((result as any).error && typeof ((result as any).error as any).message === 'string')
            ? ((result as any).error as any).message
            : `[${tag}] Operation failed`
        const err = new Error(message)
        ;(err as any).error = (result as any).error
        return err
    }

    const executeOps = async (args2: {
        channel: import('#client/types').IoChannel
        ops: Operation[]
        context?: ObservabilityContext
        signal?: AbortSignal
    }): Promise<OperationResult[]> => {
        const traceId = (typeof args2.context?.traceId === 'string' && args2.context.traceId) ? args2.context.traceId : undefined
        const opsWithTrace = Protocol.ops.build.withTraceMeta({
            ops: args2.ops,
            traceId,
            ...(args2.context ? { nextRequestId: (args2.context as any).requestId } : {})
        })
        const meta = Protocol.ops.build.buildRequestMeta({
            now,
            traceId,
            requestId: args2.context ? (args2.context as any).requestId() : undefined
        })
        Protocol.ops.validate.assertOutgoingOps({ ops: opsWithTrace, meta })

        const res = await ioExecute({
            channel: args2.channel,
            ops: opsWithTrace,
            meta,
            ...(args2.signal ? { signal: args2.signal } : {}),
            ...(args2.context ? { context: args2.context } : {})
        })

        return Protocol.ops.validate.assertOperationResults((res as any).results)
    }

    const queryChannel = async <T = unknown>(args2: {
        channel: import('#client/types').IoChannel
        store: StoreToken
        params: QueryParams
        context?: ObservabilityContext
        signal?: AbortSignal
    }): Promise<import('#client/types').ChannelQueryResult<T>> => {
        const opId = Protocol.ids.createOpId('q', { now })
        const op: Operation = Protocol.ops.build.buildQueryOp({
            opId,
            resource: String(args2.store),
            params: args2.params
        })
        const results = await executeOps({
            channel: args2.channel,
            ops: [op],
            ...(args2.context ? { context: args2.context } : {}),
            ...(args2.signal ? { signal: args2.signal } : {})
        })
        const result = requireResultByOpId(results, opId, '[Atoma] Missing query result')
        if (!(result as any).ok) throw toOpsError(result, 'query')

        const data = Protocol.ops.validate.assertQueryResultData((result as any).data) as any
        return {
            items: Array.isArray(data?.items) ? (data.items as T[]) : [],
            ...(data?.pageInfo ? { pageInfo: data.pageInfo } : {})
        }
    }

    const writeChannel = async (args2: {
        channel: import('#client/types').IoChannel
        store: StoreToken
        action: WriteAction
        items: WriteItem[]
        options?: WriteOptions
        context?: ObservabilityContext
        signal?: AbortSignal
    }): Promise<WriteResultData> => {
        const opId = Protocol.ids.createOpId('w', { now })
        const op: Operation = Protocol.ops.build.buildWriteOp({
            opId,
            write: {
                resource: String(args2.store),
                action: args2.action,
                items: args2.items,
                ...(args2.options ? { options: args2.options } : {})
            }
        })
        const results = await executeOps({
            channel: args2.channel,
            ops: [op],
            ...(args2.context ? { context: args2.context } : {}),
            ...(args2.signal ? { signal: args2.signal } : {})
        })
        const result = requireResultByOpId(results, opId, '[Atoma] Missing write result')
        if (!(result as any).ok) throw toOpsError(result, 'write')
        return Protocol.ops.validate.assertWriteResultData((result as any).data) as any
    }

    const makeChannelApi = (channel: import('#client/types').IoChannel): import('#client/types').ChannelApi => {
        return {
            query: (args2) => queryChannel({ channel, ...args2 } as any),
            write: (args2) => writeChannel({ channel, ...args2 } as any)
        }
    }

    const storeApi = makeChannelApi('store')

    const requireRemote = () => {
        if (!remoteBackend) {
            throw new Error('[Atoma] remote backend 未配置（createClient({ remote })）')
        }
        return remoteBackend
    }

    const remoteApi: import('#client/types').RemoteApi = {
        ...makeChannelApi('remote'),
        changes: {
            pull: async (args2: {
                cursor: Cursor
                limit: number
                resources?: string[]
                context?: ObservabilityContext
                signal?: AbortSignal
            }): Promise<ChangeBatch> => {
                requireRemote()
                const opId = Protocol.ids.createOpId('c', { now })
                const op: Operation = Protocol.ops.build.buildChangesPullOp({
                    opId,
                    cursor: args2.cursor as Cursor,
                    limit: args2.limit,
                    ...(args2.resources?.length ? { resources: args2.resources } : {})
                })
                const results = await executeOps({
                    channel: 'remote',
                    ops: [op],
                    ...(args2.context ? { context: args2.context } : {}),
                    ...(args2.signal ? { signal: args2.signal } : {})
                })
                const result = requireResultByOpId(results, opId, '[Atoma] Missing changes.pull result')
                if (!(result as any).ok) throw toOpsError(result, 'changes.pull')
                return (result as any).data as ChangeBatch
            }
        },
        ...(remoteBackend?.sse
            ? {
                subscribeNotify: (args2: {
                    resources?: string[]
                    onMessage: (msg: import('#client/types').NotifyMessage) => void
                    onError: (err: unknown) => void
                    signal?: AbortSignal
                }) => {
                    const remote = requireRemote()
                    const buildUrl = remote.sse!.buildUrl
                    const connect = remote.sse!.connect
                    const url = buildUrl({ resources: args2.resources })

                    let es: EventSource
                    if (connect) es = connect(url)
                    else if (typeof EventSource !== 'undefined') es = new EventSource(url)
                    else throw new Error('[Atoma] subscribeNotify: EventSource not available and no connect provided')

                    const eventName = Protocol.sse.events.NOTIFY

                    es.addEventListener(eventName, (event: any) => {
                        try {
                            const msg = Protocol.sse.parse.notifyMessage(String(event.data))
                            args2.onMessage(msg as any)
                        } catch (err) {
                            args2.onError(err)
                        }
                    })
                    es.onerror = (err) => {
                        args2.onError(err)
                    }

                    if (args2.signal) {
                        const signal = args2.signal
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
    } as any

    const desiredBaseVersionFromTargetVersion = (version: unknown): number | undefined => {
        if (typeof version !== 'number' || !Number.isFinite(version) || version <= 1) return undefined
        return Math.floor(version) - 1
    }

    const newWriteItemMeta = (): import('#protocol').WriteItemMeta => {
        return Protocol.ops.meta.newWriteItemMeta({ now })
    }

    const ensureWriteItemsOk = (data: WriteResultData, message: string) => {
        const results = Array.isArray((data as any)?.results) ? (data as any).results : []
        for (const r of results) {
            if (r && typeof r === 'object' && (r as any).ok === false) {
                const err: any = new Error(message)
                ;(err as any).error = (r as any).error
                ;(err as any).current = (r as any).current
                throw err
            }
        }
    }

    const commitWriteback = async (storeName: StoreToken, writeback: PersistWriteback<any>, options?: { context?: ObservabilityContext }) => {
        await clientRuntime.internal.applyWriteback(String(storeName), writeback as any)

        // Only mirror into the durable store backend when Store is configured as local.
        if (storeBackendState.role !== 'local') return

        const upserts = Array.isArray(writeback?.upserts) ? writeback.upserts : []
        const deletes = Array.isArray(writeback?.deletes) ? writeback.deletes : []
        const versionUpdates = Array.isArray(writeback?.versionUpdates) ? writeback.versionUpdates : []

        if (upserts.length) {
            const items: WriteItem[] = []
            for (const u of upserts) {
                const id = (u as any)?.id
                if (typeof id !== 'string' || !id) continue
                const baseVersion = desiredBaseVersionFromTargetVersion((u as any)?.version)
                items.push({
                    entityId: id,
                    ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                    value: u,
                    meta: newWriteItemMeta()
                } as any)
            }
            if (items.length) {
                const data = await storeApi.write({
                    store: storeName,
                    action: 'upsert',
                    items,
                    options: { merge: false, upsert: { mode: 'loose' } },
                    ...(options?.context ? { context: options.context } : {})
                } as any)
                ensureWriteItemsOk(data, '[Atoma] writeback.commit: mirror upsert failed')
            }
        }

        if (deletes.length) {
            const { items: currentItems } = await storeApi.query<any>({
                store: storeName,
                params: { where: { id: { in: deletes } } } as any,
                ...(options?.context ? { context: options.context } : {})
            })
            const currentById = new Map<string, any>()
            for (const row of currentItems) {
                const id = (row as any)?.id
                if (typeof id === 'string' && id) currentById.set(id, row)
            }

            const items: WriteItem[] = []
            for (const id of deletes) {
                const row = currentById.get(String(id))
                if (!row || typeof row !== 'object') continue
                const baseVersion = (row as any).version
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                    throw new Error(`[Atoma] writeback.commit: mirror delete requires baseVersion (missing version for id=${String(id)})`)
                }
                items.push({
                    entityId: String(id),
                    baseVersion,
                    meta: newWriteItemMeta()
                } as any)
            }

            if (items.length) {
                const data = await storeApi.write({
                    store: storeName,
                    action: 'delete',
                    items,
                    ...(options?.context ? { context: options.context } : {})
                } as any)
                ensureWriteItemsOk(data, '[Atoma] writeback.commit: mirror delete failed')
            }
        }

        if (versionUpdates.length) {
            const versionByKey = new Map<string, number>()
            for (const v of versionUpdates) {
                const key = String((v as any)?.key ?? '')
                const version = (v as any)?.version
                if (!key) continue
                if (!(typeof version === 'number' && Number.isFinite(version) && version > 0)) continue
                versionByKey.set(key, Math.floor(version))
            }

            const upsertedKeys = new Set<string>()
            for (const u of upserts) {
                const id = (u as any)?.id
                if (typeof id === 'string' && id) upsertedKeys.add(id)
            }

            const toUpdate = Array.from(versionByKey.keys()).filter(k => !upsertedKeys.has(k))
            if (toUpdate.length) {
                const { items: currentItems } = await storeApi.query<any>({
                    store: storeName,
                    params: { where: { id: { in: toUpdate } } } as any,
                    ...(options?.context ? { context: options.context } : {})
                })

                const items: WriteItem[] = []
                for (const row of currentItems) {
                    const id = (row as any)?.id
                    if (typeof id !== 'string' || !id) continue
                    const nextVersion = versionByKey.get(id)
                    if (nextVersion === undefined) continue

                    const baseVersion = desiredBaseVersionFromTargetVersion(nextVersion)
                    items.push({
                        entityId: id,
                        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                        value: { ...(row as any), version: nextVersion },
                        meta: newWriteItemMeta()
                    } as any)
                }

                if (items.length) {
                    const data = await storeApi.write({
                        store: storeName,
                        action: 'upsert',
                        items,
                        options: { merge: true, upsert: { mode: 'loose' } },
                        ...(options?.context ? { context: options.context } : {})
                    } as any)
                    ensureWriteItemsOk(data, '[Atoma] writeback.commit: mirror versionUpdate failed')
                }
            }
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
            use: (mw) => {
                ioMiddlewares.push(mw)
                ioExecute = composeIo()
                return () => {
                    const idx = ioMiddlewares.indexOf(mw)
                    if (idx >= 0) ioMiddlewares.splice(idx, 1)
                    ioExecute = composeIo()
                }
            },
        },
        store: storeApi,
        remote: remoteApi,
        observability: clientRuntime.observability,
        persistence: {
            register: clientRuntime.persistenceRouter.register
        },
        acks: clientRuntime.mutation.acks,
        writeback: {
            commit: (storeName, writeback, options) => commitWriteback(storeName, writeback as any, options as any)
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
