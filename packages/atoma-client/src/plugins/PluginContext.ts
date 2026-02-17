import type {
    ChangeDirection,
    Entity,
    OperationContext,
    Query,
    QueryResult,
    StoreChange,
    Store,
    StoreToken,
    StoreDelta
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type { PluginContext as PluginContextType } from 'atoma-types/client/plugins'
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
                query: <T extends Entity>({
                    storeName,
                    query
                }: {
                    storeName: StoreToken
                    query: Query<T>
                }) => {
                    const handle = runtime.stores.resolveHandle(storeName, 'plugin.runtime.stores.query')
                    return runtime.engine.query.evaluate({
                        state: handle.state,
                        query
                    }) as QueryResult<T>
                },
                applyChanges: async <T extends Entity>({
                    storeName,
                    changes,
                    direction,
                    opContext
                }: {
                    storeName: StoreToken
                    changes: ReadonlyArray<StoreChange<T>>
                    direction: ChangeDirection
                    opContext: OperationContext
                }) => {
                    const handle = runtime.stores.resolveHandle(storeName, 'plugin.runtime.stores.applyChanges')
                    await runtime.write.applyChanges(
                        handle,
                        changes,
                        direction,
                        { opContext }
                    )
                },
                applyWriteback: async <T extends Entity>({
                    storeName,
                    upserts,
                    deletes,
                    versionUpdates
                }: {
                    storeName: StoreToken
                    upserts: T[]
                    deletes: EntityId[]
                    versionUpdates?: Array<{ key: EntityId; version: number }>
                }) => {
                    const handle = runtime.stores.resolveHandle(storeName, 'plugin.runtime.stores.applyWriteback')
                    const processed = await Promise.all(
                        upserts.map((item) => runtime.transform.writeback(handle, item))
                    ) as Array<T | undefined>
                    return handle.state.applyWriteback({
                        upserts: processed.filter((item): item is T => item !== undefined),
                        deletes,
                        ...(versionUpdates ? { versionUpdates } : {})
                    } as any) as StoreDelta<T> | null
                }
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
