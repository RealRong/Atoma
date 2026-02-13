import type { Patch } from 'immer'
import type { Entity, OperationContext, Query, QueryResult } from 'atoma-types/core'
import { registerOperationClient } from 'atoma-types/client/ops'
import type { PluginContext, RuntimeExtensionContext } from 'atoma-types/client/plugins'
import { createId } from 'atoma-shared'
import type { Schema } from 'atoma-types/runtime'
import { Runtime } from 'atoma-runtime'
import type {
    AtomaClient,
    AtomaSchema,
    CreateClientOptions,
} from 'atoma-types/client'
import { installDebugIntegration } from './client/installDebugIntegration'
import { createOperationClient } from './client/createOperationClient'
import { installDirectStrategy } from './client/installDirectStrategy'
import { setupPlugins } from './plugins'
import { CapabilitiesRegistry } from './plugins/CapabilitiesRegistry'
import { OperationPipeline } from './plugins/OperationPipeline'

/**
 * Creates an Atoma client instance.
 *
 * This is the unified entry point for creating a client.
 * It handles options validation, plugin assembly, and runtime wiring.
 */
export function createClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(opt: CreateClientOptions<E, S>): AtomaClient<E, S> {
    const input = (typeof opt === 'object' && opt !== null ? opt : {}) as {
        schema?: unknown
        plugins?: unknown
    }

    const capabilities = new CapabilitiesRegistry()
    const clientId = createId()
    const operationPipeline = new OperationPipeline()

    const runtime = new Runtime({
        id: clientId,
        schema: (input.schema ?? {}) as Schema
    })

    const runtimeApi: PluginContext['runtimeApi'] = {
        id: runtime.id,
        now: runtime.now,
        queryStore: <T extends Entity>(args: { storeName: string; query: Query<T> }) => {
            const handle = runtime.stores.resolveHandle(args.storeName, 'plugin.runtimeApi.queryStore')
            return runtime.engine.query.evaluate({
                state: handle.state,
                query: args.query
            }) as QueryResult<T>
        },
        applyStorePatches: async (args: {
            storeName: string
            patches: Patch[]
            inversePatches: Patch[]
            opContext: OperationContext
        }) => {
            const handle = runtime.stores.resolveHandle(args.storeName, 'plugin.runtimeApi.applyStorePatches')
            await runtime.write.patches(
                handle,
                args.patches,
                args.inversePatches,
                { opContext: args.opContext }
            )
        }
    }

    const context: PluginContext = {
        clientId: runtime.id,
        capabilities,
        runtimeApi,
        events: {
            register: runtime.hooks.register
        }
    }

    const runtimeExtensionContext: RuntimeExtensionContext = {
        ...context,
        runtimeExtension: {
            id: runtime.id,
            now: runtime.now,
            stores: {
                resolveHandle: (name, tag) => runtime.stores.resolveHandle(name, tag)
            },
            strategy: {
                register: (key, spec) => runtime.strategy.register(key, spec),
                query: (input) => runtime.strategy.query(input),
                write: (input) => runtime.strategy.write(input)
            },
            transform: {
                writeback: (handle, data, ctx) => runtime.transform.writeback(handle, data, ctx)
            }
        }
    }

    const plugins = setupPlugins({
        context,
        runtimeExtensionContext,
        rawPlugins: Array.isArray(input.plugins) ? input.plugins : [],
        operationPipeline
    })

    const operationClient = createOperationClient({
        operationPipeline,
        clientId: runtime.id
    })

    const disposers: Array<() => void> = []

    disposers.push(registerOperationClient(capabilities, operationClient))
    disposers.push(...installDebugIntegration({ capabilities, runtime }))
    disposers.push(plugins.dispose)
    disposers.push(installDirectStrategy({ runtime, operationPipeline }))

    let disposed = false
    const dispose = () => {
        if (disposed) return
        disposed = true

        for (let i = disposers.length - 1; i >= 0; i--) {
            try {
                disposers[i]()
            } catch {
                // ignore
            }
        }
    }

    const client: AtomaClient<E, S> = {
        stores: ((name: keyof E & string) => {
            return runtime.stores.ensure(String(name))
        }) as AtomaClient<E, S>['stores'],
        dispose
    }

    const pluginInitDisposers = plugins.init(client)
    disposers.push(...pluginInitDisposers)

    return client
}
