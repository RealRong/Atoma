import type { Entity } from 'atoma-types/core'
import { createId } from 'atoma-shared'
import { Runtime } from 'atoma-runtime'
import type {
    AtomaClient,
    AtomaSchema,
    CreateClientOptions,
} from 'atoma-types/client'
import type { Schema } from 'atoma-types/runtime'
import { buildPluginContext } from './client/composition/buildPluginContext'
import { installDebugIntegration } from './client/installDebugIntegration'
import { installDirectStrategy } from './client/installDirectStrategy'
import { setupPlugins } from './plugins'
import { ServiceRegistry } from './plugins/ServiceRegistry'

/**
 * Creates an Atoma client instance.
 *
 * This is the unified entry point for creating a client.
 * It handles options validation, plugin assembly, and runtime wiring.
 */
export function createClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(options: CreateClientOptions<E, S>): AtomaClient<E, S> {
    const input = (typeof options === 'object' && options !== null ? options : {}) as {
        schema?: unknown
        plugins?: unknown
        execution?: {
            defaultRoute?: unknown
        }
    }
    const schema = (input.schema ?? {}) as Schema
    const rawPlugins = Array.isArray(input.plugins) ? input.plugins : []
    const defaultExecutionRoute = (
        typeof input.execution?.defaultRoute === 'string' && input.execution.defaultRoute.trim()
            ? input.execution.defaultRoute.trim()
            : 'direct-local'
    )

    const services = new ServiceRegistry()
    const runtime = new Runtime({
        id: createId(),
        schema
    })

    const context = buildPluginContext({
        runtime,
        services
    })

    const disposers: Array<() => void> = []
    disposers.push(...installDebugIntegration({ services, runtime }))
    disposers.push(installDirectStrategy({
        runtime,
        services,
        defaultRoute: defaultExecutionRoute
    }))

    const plugins = setupPlugins({
        context,
        rawPlugins
    })
    disposers.push(plugins.dispose)

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

    plugins.mount(client)

    return client
}
