import type {
    Entity,
    Query,
    QueryResult,
    StoreChange,
    Store,
    StoreToken,
    StoreDelta
} from 'atoma-types/core'
import type {
    PluginContext as PluginContextType,
    StoreActionOptions,
    WritebackData
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
                list: () => {
                    const names: StoreToken[] = []
                    Array.from(runtime.stores.list()).forEach((store) => {
                        const name = String((store as { name?: unknown }).name ?? '').trim()
                        if (!name) return
                        names.push(name as StoreToken)
                    })
                    return names
                },
                ensure: <T extends Entity>(storeName: StoreToken) => runtime.stores.ensure(storeName) as unknown as Store<T>,
                query: <T extends Entity>(storeName: StoreToken, query: Query<T>) => {
                    const handle = runtime.stores.ensureHandle(storeName, 'plugin.runtime.stores.query')
                    return runtime.engine.query.evaluate({
                        state: handle.state,
                        query
                    }) as QueryResult<T>
                },
                apply: async <T extends Entity>(
                    storeName: StoreToken,
                    changes: ReadonlyArray<StoreChange<T>>,
                    options?: StoreActionOptions
                ) => {
                    const handle = runtime.stores.ensureHandle(storeName, 'plugin.runtime.stores.apply')
                    await runtime.write.apply(
                        handle,
                        changes,
                        options
                    )
                },
                revert: async <T extends Entity>(
                    storeName: StoreToken,
                    changes: ReadonlyArray<StoreChange<T>>,
                    options?: StoreActionOptions
                ) => {
                    const handle = runtime.stores.ensureHandle(storeName, 'plugin.runtime.stores.revert')
                    await runtime.write.revert(
                        handle,
                        changes,
                        options
                    )
                },
                writeback: async <T extends Entity>(
                    storeName: StoreToken,
                    data: WritebackData<T>,
                    options?: StoreActionOptions
                ) => {
                    const handle = runtime.stores.ensureHandle(storeName, 'plugin.runtime.stores.writeback')
                    const context = options?.context
                        ? runtime.engine.action.createContext(options.context)
                        : undefined
                    const processed = await Promise.all(
                        data.upserts.map((item) => runtime.transform.writeback(handle, item, context))
                    ) as Array<T | undefined>
                    return handle.state.writeback({
                        upserts: processed.filter((item): item is T => item !== undefined),
                        deletes: data.deletes,
                        ...(data.versionUpdates ? { versionUpdates: data.versionUpdates } : {})
                    }) as StoreDelta<T> | null
                }
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
