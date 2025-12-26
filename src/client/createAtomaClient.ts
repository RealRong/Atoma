import type { CoreStore, Entity, IStore, OperationContext } from '#core'
import { Core } from '#core'
import { createHistoryPlugin } from './history'
import { createSyncPlugin } from './sync'
import { createClientRuntime } from './runtime'
import { applyClientPlugins } from './plugins'
import type { AtomaClient, CreateOpContextArgs, DefineClientConfig, EntitiesDefinition, StoresConstraint, StoresDefinition } from './types'

export function createOpContext(args: CreateOpContextArgs): OperationContext {
    return {
        scope: String(args.scope || 'default'),
        origin: args.origin ?? 'user',
        actionId: Core.operation.createActionId(),
        label: args.label,
        timestamp: Date.now()
    }
}

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

            const plugins = applyClientPlugins(runtime, [
                createHistoryPlugin(),
                createSyncPlugin({ syncConfig: config.sync })
            ])

            const Store = (<Name extends keyof Entities & string>(name: Name) => {
                return runtime.Store(name) as unknown as CoreStore<Entities[Name], any>
            }) as AtomaClient<Entities, Stores>['Store']

            const resolveStore = ((name: string) => {
                return runtime.resolveStore(name) as unknown as IStore<any>
            }) as AtomaClient<Entities, Stores>['resolveStore']

            const client: AtomaClient<Entities, Stores> = {
                Store,
                resolveStore,
                ...(plugins.client as any)
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
