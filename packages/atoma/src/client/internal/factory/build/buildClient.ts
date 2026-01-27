import type { Entity, StoreDataProcessor, StoreToken } from '#core'
import { HistoryController } from '#client/internal/controllers/HistoryController'
import { ClientRuntime } from '#client/internal/factory/runtime/createClientRuntime'
import { Protocol } from '#protocol'
import type { Backend } from '#backend'
import { HttpOpsClient } from '#backend/ops/http/HttpOpsClient'
import type {
    AtomaClient,
    AtomaSchema,
    ClientPlugin,
} from '#client/types'
import type { ObservabilityContext } from '#observability'
import { registerClientRuntime } from '../../../../internal/runtimeRegistry'

export function buildAtomaClient<
    const Entities extends Record<string, Entity>,
    const Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
>(args: {
    schema: Schema
    dataProcessor?: StoreDataProcessor<any>
    backend: Backend
    plugins?: ReadonlyArray<ClientPlugin<any>>
}): AtomaClient<Entities, Schema> {
    const backend = args.backend
    const storeBackend = backend.store
    const remoteBackend = backend.remote
    const clientKey = String(backend.key)

    const storePersistence = backend.capabilities?.storePersistence ?? 'remote'
    const storeRole: 'local' | 'remote' = (storePersistence === 'remote') ? 'remote' : 'local'

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
            throw new Error('[Atoma] io: remote backend 未配置（createClient({ backend })）')
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

    const client: any = {}

    const clientRuntime = new ClientRuntime({
        schema: args.schema,
        dataProcessor: args.dataProcessor,
        mirrorWritebackToStore: storePersistence === 'durable',
        ownerClient: () => client,
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

    const resolveStore = (<Name extends keyof Entities & string>(name: Name) => {
        return clientRuntime.stores.resolveStore(String(name)) as any
    })

    const stores = new Proxy(resolveStore as any, {
        get: (target, prop, receiver) => {
            // Prevent accidental thenable behavior (e.g. `await client.stores`).
            if (prop === 'then') return undefined
            if (prop === Symbol.toStringTag) return 'AtomaStores'

            // Preserve built-in function props (name/length/prototype/call/apply/bind/etc).
            if (typeof prop !== 'string' || prop in target) {
                return Reflect.get(target, prop, receiver)
            }

            return resolveStore(prop as any)
        },
        apply: (_target, _thisArg, argArray) => {
            return resolveStore(argArray[0] as any)
        }
    }) as unknown as AtomaClient<Entities, Schema>['stores']

    client.stores = stores
    client.History = historyController.history

    registerClientRuntime(client, clientRuntime)

    const kind = (() => {
        const opsClient: any = storeBackend.opsClient
        const ctorName = (opsClient && typeof opsClient === 'object' && (opsClient as any).constructor && typeof (opsClient as any).constructor.name === 'string')
            ? String((opsClient as any).constructor.name)
            : ''

        // Avoid importing non-HTTP backends into the core client package.
        // Backend packages can still expose meaningful class names for devtools purposes.
        if (ctorName === 'IndexedDBOpsClient') return 'indexeddb' as const
        if (ctorName === 'MemoryOpsClient') return 'memory' as const

        if (opsClient instanceof HttpOpsClient || ctorName === 'HttpOpsClient') {
            return (storePersistence === 'durable' ? 'localServer' : 'http') as 'localServer' | 'http'
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
            throw new Error('[Atoma] remote backend 未配置（createClient({ backend })）')
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
        ...(remoteBackend?.notify
            ? {
                subscribeNotify: (args2: {
                    resources?: string[]
                    onMessage: (msg: import('#client/types').NotifyMessage) => void
                    onError: (err: unknown) => void
                    signal?: AbortSignal
                }) => {
                    const remote = requireRemote()
                    return remote.notify!.subscribe(args2 as any)
                }
            }
            : {})
    } as any

    const ctx: import('#client/types').ClientPluginContext = {
        client,
        runtime: clientRuntime,
        meta: {
            clientKey,
            storeBackend: {
                role: storeRole,
                kind
            }
        },
        historyDevtools: historyController.devtools,
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
            commit: (storeName, writeback, options) => clientRuntime.internal.commitWriteback(storeName as any, writeback as any, options as any)
        },
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

    if (args.plugins?.length) {
        for (const plugin of args.plugins) {
            client.use(plugin as any)
        }
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
            backend.dispose?.()
        } catch {
            // ignore
        }
    }

    return client as AtomaClient<Entities, Schema>
}
