import type { Patch } from 'immer'
import type { OperationClient } from 'atoma-types/client/ops'
import type { Entity, OperationContext, Query, QueryResult, StoreToken } from 'atoma-types/core'
import type { PluginContext } from 'atoma-types/client/plugins'
import { Runtime } from 'atoma-runtime'
import { CapabilitiesRegistry } from '../../plugins/CapabilitiesRegistry'

export function buildPluginContext({
    runtime,
    capabilities,
    operation
}: {
    runtime: Runtime
    capabilities: CapabilitiesRegistry
    operation: OperationClient
}): PluginContext {
    const pluginRuntime: PluginContext['runtime'] = {
        id: runtime.id,
        now: runtime.now,
        stores: {
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
                )
                const upserts = processed.filter((item): item is T => item !== undefined)

                handle.state.applyWriteback({
                    upserts,
                    deletes: input.deletes,
                    ...(input.versionUpdates ? { versionUpdates: input.versionUpdates } : {})
                } as any)
            }
        },
        strategy: {
            register: (key, spec) => runtime.strategy.register(key, spec),
            query: async <T extends Entity>(input: {
                storeName: StoreToken
                query: Query<T>
                signal?: AbortSignal
            }) => {
                const handle = runtime.stores.resolveHandle(input.storeName, 'plugin.runtime.strategy.query')
                return await runtime.strategy.query<T>({
                    storeName: input.storeName,
                    handle: handle as any,
                    query: input.query,
                    ...(input.signal ? { signal: input.signal } : {})
                })
            },
            write: (input) => runtime.strategy.write(input)
        }
    }

    return {
        clientId: runtime.id,
        capabilities,
        operation,
        runtime: pluginRuntime,
        events: {
            register: runtime.hooks.register
        }
    }
}
