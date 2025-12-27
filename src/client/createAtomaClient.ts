import type { CoreStore, Entity } from '#core'
import { createHistoryController } from './controllers/HistoryController'
import { createSyncController } from './controllers/SyncController'
import { createClientRuntime } from './runtime'
import type { AtomaClient, DefineClientConfig, EntitiesDefinition, StoresConstraint, StoresDefinition } from './types'

const defineStoresInternal = <
    const Entities extends Record<string, Entity>,
    const Stores extends StoresConstraint<Entities>
>(stores: Stores): StoresDefinition<Entities, Stores> => {
    return {
        defineClient: (config: DefineClientConfig<Entities>) => {
            const runtime = createClientRuntime({
                stores,
                config
            })

            const historyController = createHistoryController({ runtime })
            const syncController = createSyncController({
                runtime,
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
