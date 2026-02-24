import type {
    PluginContext as PluginContextType,
} from 'atoma-types/client/plugins'
import type { Entity, Query } from 'atoma-types/core'
import type { Runtime } from 'atoma-runtime'
import { ServiceRegistry } from './ServiceRegistry'

export class PluginContext implements PluginContextType {
    readonly clientId: string
    readonly services: PluginContextType['services']
    readonly runtime: PluginContextType['runtime']
    readonly events: PluginContextType['events']

    constructor(runtime: Runtime) {
        const services = new ServiceRegistry()

        this.clientId = runtime.id
        this.services = {
            register: services.register,
            resolve: services.resolve
        }
        this.runtime = {
            id: runtime.id,
            now: runtime.now,
            stores: {
                list: runtime.stores.list,
                use: runtime.stores.use,
                peek: <T extends Entity = Entity>(storeName: string, id: string) => {
                    const data = runtime.stores.use<T>(storeName).query({
                        filter: {
                            op: 'eq',
                            field: 'id',
                            value: id
                        }
                    } as Query<T>).data[0]
                    return data === undefined ? undefined : data
                },
                snapshot: runtime.stores.snapshot
            },
            action: {
                createContext: runtime.engine.action.createContext
            },
            execution: {
                register: runtime.execution.register,
                hasExecutor: runtime.execution.hasExecutor
            }
        }
        this.events = {
            on: runtime.events.on,
            off: runtime.events.off,
            once: runtime.events.once
        }
    }
}
