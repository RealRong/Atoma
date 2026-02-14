import type { Patch } from 'immer'
import type { Entity, OperationContext, Query, QueryResult, StoreToken, ExecutionRoute } from 'atoma-types/core'
import type { PluginContext } from 'atoma-types/client/plugins'
import type { StoreHandle } from 'atoma-types/runtime'
import type { Runtime } from 'atoma-runtime'
import type { ServiceRegistry } from '../../plugins/ServiceRegistry'

export function buildPluginContext({
    runtime,
    services
}: {
    runtime: Runtime
    services: ServiceRegistry
}): PluginContext {
    const pluginRuntime: PluginContext['runtime'] = {
        id: runtime.id,
        now: runtime.now,
        stores: {
            resolveHandle: <T extends Entity>(input: {
                storeName: StoreToken
                reason: string
            }) => {
                return runtime.stores.resolveHandle(input.storeName, input.reason) as unknown as StoreHandle<T>
            },
            query: <T extends Entity>(input: {
                storeName: StoreToken
                query: Query<T>
            }) => {
                const handle = runtime.stores.resolveHandle(input.storeName, 'plugin.runtime.stores.query')
                return runtime.engine.query.evaluate({
                    state: handle.state,
                    query: input.query
                }) as QueryResult<T>
            },
            applyPatches: async (input: {
                storeName: StoreToken
                patches: Patch[]
                inversePatches: Patch[]
                opContext: OperationContext
            }) => {
                const handle = runtime.stores.resolveHandle(input.storeName, 'plugin.runtime.stores.applyPatches')
                await runtime.write.patches(
                    handle,
                    input.patches,
                    input.inversePatches,
                    { opContext: input.opContext }
                )
            },
            applyWriteback: async <T extends Entity>(input: {
                storeName: StoreToken
                upserts: T[]
                deletes: string[]
                versionUpdates?: Array<{ key: string; version: number }>
            }) => {
                const handle = runtime.stores.resolveHandle(input.storeName, 'plugin.runtime.stores.applyWriteback')

                const processed = await Promise.all(
                    input.upserts.map(item => runtime.transform.writeback(handle, item))
                ) as Array<T | undefined>
                const upserts = processed.filter((item): item is T => item !== undefined)

                handle.state.applyWriteback({
                    upserts,
                    deletes: input.deletes,
                    ...(input.versionUpdates ? { versionUpdates: input.versionUpdates } : {})
                } as any)
            }
        },
        execution: {
            apply: runtime.execution.apply,
            resolvePolicy: runtime.execution.resolvePolicy,
            subscribe: runtime.execution.subscribe,
            query: async <T extends Entity>(input: {
                storeName: StoreToken
                route?: ExecutionRoute
                query: Query<T>
                signal?: AbortSignal
            }) => {
                const handle = runtime.stores.resolveHandle(input.storeName, 'plugin.runtime.execution.query')
                return await runtime.execution.query<T>(
                    {
                        handle: handle as any,
                        query: input.query
                    },
                    {
                        ...(input.route !== undefined ? { route: input.route } : {}),
                        ...(input.signal ? { signal: input.signal } : {})
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

    return {
        clientId: runtime.id,
        services: {
            register: services.register,
            resolve: services.resolve
        },
        runtime: pluginRuntime,
        events: {
            register: runtime.hooks.register
        }
    }
}
