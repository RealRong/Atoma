import type { Patch } from 'immer'
import type { Entity, OperationContext, Query, QueryResult, StoreToken, ExecutionRoute } from 'atoma-types/core'
import type { PluginContext as PluginContextType } from 'atoma-types/client/plugins'
import type { StoreHandle } from 'atoma-types/runtime'
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
                resolveHandle: <T extends Entity>({
                    storeName,
                    reason
                }: {
                    storeName: StoreToken
                    reason: string
                }) => runtime.stores.resolveHandle(storeName, reason) as unknown as StoreHandle<T>,
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
                applyPatches: async ({
                    storeName,
                    patches,
                    inversePatches,
                    opContext
                }: {
                    storeName: StoreToken
                    patches: Patch[]
                    inversePatches: Patch[]
                    opContext: OperationContext
                }) => {
                    const handle = runtime.stores.resolveHandle(storeName, 'plugin.runtime.stores.applyPatches')
                    await runtime.write.patches(
                        handle,
                        patches,
                        inversePatches,
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
                    deletes: string[]
                    versionUpdates?: Array<{ key: string; version: number }>
                }) => {
                    const handle = runtime.stores.resolveHandle(storeName, 'plugin.runtime.stores.applyWriteback')
                    const processed = await Promise.all(
                        upserts.map((item) => runtime.transform.writeback(handle, item))
                    ) as Array<T | undefined>
                    handle.state.applyWriteback({
                        upserts: processed.filter((item): item is T => item !== undefined),
                        deletes,
                        ...(versionUpdates ? { versionUpdates } : {})
                    } as any)
                }
            },
            debug: runtime.debug,
            execution: {
                apply: runtime.execution.apply,
                subscribe: runtime.execution.subscribe,
                query: <T extends Entity>({
                    storeName,
                    route,
                    query,
                    signal
                }: {
                    storeName: StoreToken
                    route?: ExecutionRoute
                    query: Query<T>
                    signal?: AbortSignal
                }) => {
                    const handle = runtime.stores.resolveHandle(storeName, 'plugin.runtime.execution.query')
                    return runtime.execution.query<T>(
                        {
                            handle: handle as any,
                            query
                        },
                        {
                            ...(route !== undefined ? { route } : {}),
                            ...(signal ? { signal } : {})
                        }
                    )
                },
                write: runtime.execution.write
            },
            engine: {
                query: {
                    evaluate: runtime.engine.query.evaluate
                }
            },
        }
        this.events = {
            register: runtime.events.register
        }
    }
}
