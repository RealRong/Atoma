import type { CoreStore, Entity } from '#core'
import { Core } from '#core'
import { createHistoryController } from './controllers/HistoryController'
import { createSyncController } from './controllers/SyncController'
import { createClientRuntime } from './runtime'
import type { AtomaClient, DefineClientConfig, EntitiesDefinition, StoresConstraint, StoresDefinition } from './types'
import { resolveBackend } from './backend'
import { OpsDataSource } from '../datasources'
import type { BatchEngine } from '#batch'
import { Batch } from '#batch'
import { Protocol } from '#protocol'

const defineStoresInternal = <
    const Entities extends Record<string, Entity>,
    const Stores extends StoresConstraint<Entities>
>(stores: Stores): StoresDefinition<Entities, Stores> => {
    return {
        defineClient: (config: DefineClientConfig<Entities>) => {
            const backends = resolveBackend(config.backend)
            const dataSourceBackend = backends.dataSource

            const resolveSharedBatchEngine = (() => {
                let initialized = false
                let shared: BatchEngine | undefined

                const parse = (batch: any): { enabled: boolean; endpoint?: string; maxBatchSize?: number; flushIntervalMs?: number } => {
                    if (batch === true) return { enabled: true }
                    if (batch === false) return { enabled: false }
                    const cfg = (batch && typeof batch === 'object' && !Array.isArray(batch)) ? batch : {}
                    return {
                        enabled: cfg.enabled !== false,
                        endpoint: typeof cfg.endpoint === 'string' ? cfg.endpoint : undefined,
                        maxBatchSize: typeof cfg.maxBatchSize === 'number' ? cfg.maxBatchSize : undefined,
                        flushIntervalMs: typeof cfg.flushIntervalMs === 'number' ? cfg.flushIntervalMs : undefined
                    }
                }

                return () => {
                    if (initialized) return shared
                    initialized = true

                    const parsed = parse(config.remote?.batch)
                    if (!parsed.enabled) return undefined

                    shared = Batch.create({
                        endpoint: parsed.endpoint ?? Protocol.http.paths.OPS,
                        maxBatchSize: parsed.maxBatchSize,
                        flushIntervalMs: parsed.flushIntervalMs,
                        opsClient: dataSourceBackend.opsClient,
                        onError: (error) => {
                            // eslint-disable-next-line no-console
                            console.error('[Atoma] batch request failed', error)
                        }
                    })
                    return shared
                }
            })()

            const defaultDataSourceFactory = config.defaults?.dataSourceFactory
                ? config.defaults.dataSourceFactory
                : ((resourceName: string) => {
                    return new OpsDataSource<any>({
                        opsClient: dataSourceBackend.opsClient,
                        name: dataSourceBackend.key,
                        resourceName,
                        batchEngine: resolveSharedBatchEngine(),
                    })
                })

            const runtime = createClientRuntime({
                stores,
                defaults: {
                    dataSourceFactory: defaultDataSourceFactory,
                    idGenerator: config.defaults?.idGenerator
                }
            })

            const historyController = createHistoryController({ runtime })
            const syncController = createSyncController({
                runtime,
                backend: backends.sync,
                localBackend: backends.local,
                syncConfig: config.sync
            })

            const STORE_HANDLE_KEY = Symbol.for('atoma.storeHandle')

            const Store = (<Name extends keyof Entities & string>(name: Name) => {
                return runtime.Store(name) as unknown as CoreStore<Entities[Name], any>
            }) as AtomaClient<Entities, Stores>['Store']

            const withOutboxOptions = <TOptions extends object | undefined>(options: TOptions): TOptions => {
                const anyOptions = (options && typeof options === 'object' && !Array.isArray(options)) ? (options as any) : {}
                const base = (anyOptions.__atoma && typeof anyOptions.__atoma === 'object' && !Array.isArray(anyOptions.__atoma))
                    ? anyOptions.__atoma
                    : {}
                return {
                    ...anyOptions,
                    __atoma: {
                        ...base,
                        persist: 'outbox',
                        allowImplicitFetchForWrite: false
                    }
                } as TOptions
            }

            const syncStoreCache = new Map<string, any>()

            const wrapSyncStore = (base: any) => {
                const cacheKey = String((base && typeof base === 'object' && (base as any).name) ? (base as any).name : 'store')
                const existing = syncStoreCache.get(cacheKey)
                if (existing) return existing

                const wrapper: any = {
                    ...base,
                    addOne: (item: any, options?: any) => base.addOne(item, withOutboxOptions(options)),
                    addMany: (items: any, options?: any) => base.addMany(items, withOutboxOptions(options)),
                    updateOne: (id: any, recipe: any, options?: any) => base.updateOne(id, recipe, withOutboxOptions(options)),
                    updateMany: (items: any, options?: any) => base.updateMany(items, withOutboxOptions(options)),
                    deleteOne: (id: any, options?: any) => base.deleteOne(id, withOutboxOptions(options)),
                    deleteMany: (ids: any, options?: any) => base.deleteMany(ids, withOutboxOptions(options)),
                    upsertOne: (item: any, options?: any) => base.upsertOne(item, withOutboxOptions(options)),
                    upsertMany: (items: any, options?: any) => base.upsertMany(items, withOutboxOptions(options)),
                    createServerAssignedOne: () => {
                        throw new Error('[Atoma] Sync.Store: createServerAssignedOne 不可用（Server-ID create 必须 direct）')
                    },
                    createServerAssignedMany: () => {
                        throw new Error('[Atoma] Sync.Store: createServerAssignedMany 不可用（Server-ID create 必须 direct）')
                    },
                    withRelations: (factory: any) => wrapSyncStore(base.withRelations(factory))
                }

                const handle = Core.store.getHandle(base)
                if (handle) {
                    ; (wrapper as any)[STORE_HANDLE_KEY] = handle
                }

                syncStoreCache.set(cacheKey, wrapper)
                return wrapper
            }

            const Sync = {
                ...syncController.sync,
                Store: (<Name extends keyof Entities & string>(name: Name) => {
                    return wrapSyncStore(Store(name))
                }) as AtomaClient<Entities, Stores>['Sync']['Store']
            } as AtomaClient<Entities, Stores>['Sync']

            const client: AtomaClient<Entities, Stores> = {
                Store,
                Sync,
                History: historyController.history
            }

            return client
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
