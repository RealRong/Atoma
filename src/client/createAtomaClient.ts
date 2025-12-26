import type { Entity, OperationContext } from '#core'
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
                stores: stores as any,
                config: config as any
            })

            const plugins = applyClientPlugins(runtime, [
                createHistoryPlugin(),
                createSyncPlugin({ syncConfig: config.sync })
            ])

            const client: AtomaClient<any, any> = {
                Store: runtime.Store as any,
                resolveStore: runtime.resolveStore as any,
                ...(plugins.client as any)
            }

            return client as any
        }
    }
}

export function defineEntities<
    const Entities extends Record<string, Entity>
>(): EntitiesDefinition<Entities> {
    function defineStores(): StoresDefinition<Entities, {}>
    function defineStores<const Stores extends StoresConstraint<Entities>>(
        stores: Stores & StoresConstraint<Entities>
    ): StoresDefinition<Entities, Stores>
    function defineStores(storesArg?: any): StoresDefinition<Entities, any> {
        return defineStoresInternal<Entities, any>((storesArg ?? {}) as any)
    }

    return {
        defineStores
    }
}
