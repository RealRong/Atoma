import type {
    PluginContext as PluginContextType,
} from 'atoma-types/client/plugins'
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
                use: runtime.stores.use
            },
            action: {
                createContext: runtime.engine.action.createContext
            },
            execution: {
                apply: runtime.execution.apply,
                subscribe: runtime.execution.subscribe
            },
            snapshot: {
                store: runtime.debug.snapshotStore,
                indexes: runtime.debug.snapshotIndexes
            },
        }
        this.events = {
            register: runtime.events.register
        }
    }
}
