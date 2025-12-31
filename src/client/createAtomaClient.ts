import type { CoreStore, Entity } from '#core'
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
                syncConfig: config.sync,
                idRemapSink: historyController.recordIdRemap
            })

            const Store = (<Name extends keyof Entities & string>(name: Name) => {
                return runtime.Store(name) as unknown as CoreStore<Entities[Name], any>
            }) as AtomaClient<Entities, Stores>['Store']

            const client: AtomaClient<Entities, Stores> = {
                Store,
                history: historyController.history,
                sync: syncController.sync
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
