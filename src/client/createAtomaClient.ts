import type { CoreStore, Entity } from '#core'
import { createHistoryController } from './controllers/HistoryController'
import { createSyncController } from './controllers/SyncController'
import { createClientRuntime } from './runtime'
import type {
    AtomaClient,
    AtomaClientBuilder,
    BackendConfig,
    BackendEndpointConfig,
    EntitiesDefinition,
    StoresConstraint,
    StoresDefinition,
    StoreDefaultsArgs,
    StoreBatchArgs,
    StoreBackendEndpointConfig,
    SyncDefaultsArgs,
    SyncQueueWritesArgs
} from './types'
import { resolveBackend } from './backend'
import { OpsDataSource } from '../datasources'

const defineStoresInternal = <
    const Entities extends Record<string, Entity>,
    const Stores extends StoresConstraint<Entities>
>(stores: Stores): StoresDefinition<Entities, Stores> => {
    return {
        defineClient: () => {
            type StoreBackendState =
                | { role: 'local'; backend: StoreBackendEndpointConfig }
                | { role: 'remote'; backend: StoreBackendEndpointConfig }

            const state: {
                storeBackend?: StoreBackendState
                storeDefaults?: StoreDefaultsArgs<Entities>
                storeBatch?: StoreBatchArgs
                syncTarget?: BackendEndpointConfig
                syncQueueWrites?: SyncQueueWritesArgs
                syncDefaults?: SyncDefaultsArgs
            } = {}

            const build = (): AtomaClient<Entities, Stores> => {
                if (!state.storeBackend) {
                    throw new Error('[Atoma] defineClient().build: 缺少 store.backend 配置')
                }

                const syncQueue = state.syncQueueWrites
                const defaults = state.syncDefaults
                const wantsSync = Boolean(state.syncTarget || syncQueue || defaults)

                const storeBackend = state.storeBackend
                const derivedSyncTarget = (!state.syncTarget && storeBackend.role === 'remote')
                    ? storeBackend.backend
                    : undefined
                const syncTarget: BackendConfig | undefined = state.syncTarget ?? derivedSyncTarget

                if (wantsSync && !syncTarget) {
                    throw new Error('[Atoma] defineClient().build: 使用 sync 相关配置前必须先配置 sync.target（或将 store.backend 设为 remote，以便复用同一对端）')
                }

                if (syncQueue?.mode === 'save-local-then-queue' && storeBackend.role !== 'local') {
                    throw new Error('[Atoma] defineClient().build: sync.queueWrites(mode=save-local-then-queue) 需要 store.backend 为本地 durable（indexedDB/server/custom local）')
                }

                const resolved = (() => {
                    if (storeBackend.role === 'local') {
                        const remote = state.syncTarget
                        const config: BackendConfig = remote
                            ? { local: storeBackend.backend, remote }
                            : storeBackend.backend
                        const backends = resolveBackend(config)
                        return {
                            store: backends,
                            sync: backends
                        }
                    }

                    const store = resolveBackend(storeBackend.backend)
                    const sync = syncTarget ? resolveBackend(syncTarget) : store
                    return { store, sync }
                })()

                if (wantsSync && !resolved.sync?.sync) {
                    throw new Error('[Atoma] defineClient().build: sync.target 必须是可用于同步的对端（需要 remote opsClient 能力）')
                }

                const dataSourceBackend = resolved.store.dataSource

                const dataSourceFactory = state.storeDefaults?.dataSourceFactory ?? ((resourceName: string) => {
                    return new OpsDataSource<any>({
                        opsClient: dataSourceBackend.opsClient,
                        name: dataSourceBackend.key,
                        resourceName,
                        batch: state.storeBatch ?? false
                    })
                })

                const runtime = createClientRuntime({
                    stores,
                    defaults: {
                        dataSourceFactory: dataSourceFactory as any,
                        idGenerator: state.storeDefaults?.idGenerator
                    }
                })

                const historyController = createHistoryController({ runtime })

                const syncConfig = wantsSync
                    ? ({
                        resources: defaults?.resources,
                        cursorKey: defaults?.cursorKey,
                        subscribe: defaults?.subscribe,
                        subscribeEventName: defaults?.subscribeEventName,
                        pullLimit: defaults?.pullLimit,
                        pullDebounceMs: defaults?.pullDebounceMs,
                        periodicPullIntervalMs: defaults?.periodicPullIntervalMs,
                        reconnectDelayMs: defaults?.reconnectDelayMs,
                        inFlightTimeoutMs: defaults?.inFlightTimeoutMs,
                        retry: defaults?.retry,
                        backoff: defaults?.backoff,
                        lockKey: defaults?.lockKey,
                        lockTtlMs: defaults?.lockTtlMs,
                        lockRenewIntervalMs: defaults?.lockRenewIntervalMs,
                        now: defaults?.now,
                        conflictStrategy: defaults?.conflictStrategy,
                        returning: defaults?.returning,
                        onEvent: defaults?.onEvent,
                        onError: defaults?.onError,
                        ...(syncQueue ? {
                            outboxKey: syncQueue.outboxKey,
                            maxQueueSize: syncQueue.maxSize,
                            outboxEvents: (syncQueue.onQueueChange || syncQueue.onQueueFull)
                                ? {
                                    ...(syncQueue.onQueueChange ? { onQueueChange: syncQueue.onQueueChange } : {}),
                                    ...(syncQueue.onQueueFull ? { onQueueFull: (droppedOp: any, maxSize: number) => syncQueue.onQueueFull?.({ maxSize, droppedOp }) } : {})
                                }
                                : undefined,
                            writePath: syncQueue.mode
                        } : {})
                    } as any)
                    : undefined

                const syncController = createSyncController({
                    runtime,
                    backend: resolved.sync.sync,
                    localBackend: resolved.store.local,
                    syncConfig
                })

                const Store = (<Name extends keyof Entities & string>(name: Name) => {
                    return runtime.Store(name) as unknown as CoreStore<Entities[Name], any>
                }) as AtomaClient<Entities, Stores>['Store']

                const Sync = {
                    ...syncController.sync,
                    Store: (<Name extends keyof Entities & string>(name: Name) => {
                        return runtime.SyncStore(name) as any
                    }) as AtomaClient<Entities, Stores>['Sync']['Store']
                } as AtomaClient<Entities, Stores>['Sync']

                const client: AtomaClient<Entities, Stores> = {
                    Store,
                    Sync,
                    History: historyController.history
                }

                return client
            }

            const builder: AtomaClientBuilder<Entities, Stores> = {
                store: {
                    defaults: (args) => {
                        state.storeDefaults = args
                        return builder
                    },
                    batch: (args) => {
                        state.storeBatch = args
                        return builder
                    },
                    backend: {
                        http: (args) => {
                            const anyArgs = args as any
                            if ('subscribePath' in anyArgs || 'subscribeUrl' in anyArgs || 'eventSourceFactory' in anyArgs) {
                                throw new Error('[Atoma] store.backend.http: subscribe/SSE 配置属于 sync，请使用 sync.target.http 配置 subscribePath/subscribeUrl/eventSourceFactory')
                            }
                            state.storeBackend = { role: 'remote', backend: { http: args } }
                            return builder
                        },
                        server: (args) => {
                            const anyArgs = args as any
                            if ('subscribePath' in anyArgs || 'subscribeUrl' in anyArgs || 'eventSourceFactory' in anyArgs) {
                                throw new Error('[Atoma] store.backend.server: subscribe/SSE 配置属于 sync，请使用 sync.target.http 配置 subscribePath/subscribeUrl/eventSourceFactory')
                            }
                            state.storeBackend = { role: 'local', backend: { http: args } }
                            return builder
                        },
                        indexedDB: (args) => {
                            state.storeBackend = { role: 'local', backend: { indexeddb: args } }
                            return builder
                        },
                        custom: (args) => {
                            state.storeBackend = { role: args.role, backend: args.backend }
                            return builder
                        }
                    }
                },
                sync: {
                    target: {
                        http: (args) => {
                            state.syncTarget = { http: args }
                            return builder
                        },
                        custom: (args) => {
                            state.syncTarget = args
                            return builder
                        }
                    },
                    queueWrites: (args) => {
                        state.syncQueueWrites = args
                        return builder
                    },
                    defaults: (args) => {
                        state.syncDefaults = args
                        return builder
                    }
                },
                build
            }

            return builder
        }
    }
}

export function defineEntities<
    const Entities extends Record<string, Entity>
>(): EntitiesDefinition<Entities> {
    function defineStores(): StoresDefinition<Entities, {}>
    function defineStores<const Stores extends StoresConstraint<Entities>>(
        stores: Stores
    ): StoresDefinition<Entities, Stores>
    function defineStores<const Stores extends StoresConstraint<Entities> = {}>(
        storesArg?: Stores & StoresConstraint<Entities>
    ): StoresDefinition<Entities, Stores> {
        return defineStoresInternal<Entities, Stores>(((storesArg ?? {}) as unknown) as Stores)
    }

    return {
        defineStores
    }
}
