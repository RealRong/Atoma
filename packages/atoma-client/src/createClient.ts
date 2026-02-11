import type { Entity } from 'atoma-types/core'
import { registerOpsClient } from 'atoma-types/client/ops'
import { createOpId } from 'atoma-types/protocol-tools'
import type { PersistRequest, PersistResult, Schema } from 'atoma-types/runtime'
import { Runtime } from 'atoma-runtime'
import type {
    AtomaClient,
    AtomaSchema,
    CreateClientOptions,
} from 'atoma-types/client'
import { DEBUG_HUB_CAPABILITY } from 'atoma-types/devtools'
import { createDebugHub } from './debug/debugHub'
import { registerRuntimeDebugProviders } from './debug/registerRuntimeDebugProviders'
import { setupPlugins } from './plugins'
import { CapabilitiesRegistry } from './plugins/CapabilitiesRegistry'
import { markTerminalResult } from './plugins/HandlerChain'
import { PluginOpsClient } from './plugins/PluginOpsClient'
import { PluginRegistry } from './plugins/PluginRegistry'
import { PluginRuntimeIo } from './plugins/PluginRuntimeIo'

function ensureDebugHub(capabilities: CapabilitiesRegistry): (() => void) | undefined {
    const existing = capabilities.get(DEBUG_HUB_CAPABILITY)
    if (existing) {
        return
    }
    return capabilities.register(DEBUG_HUB_CAPABILITY, createDebugHub())
}

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
    const clientId = createOpId('client')

    const pluginRegistry = new PluginRegistry()
    const runtimeIo = new PluginRuntimeIo({
        clientId,
        pluginRegistry
    })

    const runtime = new Runtime({
        id: clientId,
        schema: (input.schema ?? {}) as Schema,
        io: runtimeIo
    })

    const context = {
        clientId: runtime.id,
        capabilities,
        runtime,
        hooks: runtime.hooks
    }

    const plugins = setupPlugins({
        context,
        rawPlugins: Array.isArray(input.plugins) ? input.plugins : [],
        pluginRegistry
    })

    const opsClient = new PluginOpsClient({
        pluginRegistry,
        clientId: runtime.id
    })

    const disposers: Array<() => void> = []

    disposers.push(registerOpsClient(capabilities, opsClient))

    const unregisterDebugHub = ensureDebugHub(capabilities)
    if (unregisterDebugHub) {
        disposers.push(unregisterDebugHub)
    }

    const debugHub = capabilities.get(DEBUG_HUB_CAPABILITY)
    if (debugHub) {
        disposers.push(registerRuntimeDebugProviders(runtime, debugHub))
    }

    disposers.push(plugins.dispose)

    const unregisterDirectStrategy = runtime.strategy.register('direct', {
        persist: async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
            return await pluginRegistry.execute({
                name: 'persist',
                req: req as unknown as PersistRequest<Entity>,
                ctx: {
                    clientId: runtime.id,
                    storeName: String(req.storeName)
                },
                terminal: () => markTerminalResult({ status: 'confirmed' as const })
            }) as PersistResult<T>
        }
    })

    const restoreDefaultStrategy = runtime.strategy.setDefaultStrategy('direct')
    disposers.push(restoreDefaultStrategy)
    disposers.push(unregisterDirectStrategy)

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
