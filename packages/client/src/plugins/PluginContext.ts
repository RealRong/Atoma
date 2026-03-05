import type {
    PluginContext as PluginContextType,
} from '@atoma-js/types/client/plugins'
import type { Runtime } from '@atoma-js/runtime'
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
                peek: runtime.stores.peek,
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
