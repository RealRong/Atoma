import type { Entity } from 'atoma-types/core'
import type { PersistRequest, PersistResult, Io, Schema } from 'atoma-types/runtime'
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
    const runtime = new Runtime({
        schema: (input.schema ?? {}) as Schema,
        io: {} as Io
    })

    const context = {
        clientId: runtime.id,
        capabilities,
        runtime,
        hooks: runtime.hooks
    }

    const plugins = setupPlugins({
        context,
        rawPlugins: Array.isArray(input.plugins) ? input.plugins : []
    })

    runtime.io = new PluginRuntimeIo({
        io: plugins.chains.io,
        read: plugins.chains.read,
        now: runtime.now,
        clientId: runtime.id
    })

    const disposers: Array<() => void> = []

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
        persist: async <T extends Entity>({ req }: { req: PersistRequest<T> }): Promise<PersistResult<T>> => {
            return await plugins.chains.persist.execute(req, {
                clientId: runtime.id,
                storeName: String(req.storeName)
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
