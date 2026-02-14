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
    if (typeof options !== 'object' || options === null) {
        throw new Error('[Atoma] createClient: options 必须是对象')
    }

    const schema = (options.schema ?? {}) as Schema
    const rawPlugins = options.plugins ?? []
    if (!Array.isArray(rawPlugins)) {
        throw new Error('[Atoma] createClient: plugins 必须是数组')
    }

    const rawDefaultRoute = options.execution?.defaultRoute
    const defaultExecutionRoute = rawDefaultRoute
        ? String(rawDefaultRoute).trim()
        : 'direct-local'
    if (!defaultExecutionRoute) {
        throw new Error('[Atoma] createClient: execution.defaultRoute 不能为空')
    }

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
    disposers.push(installDirectStrategy({ runtime, services }))

    const plugins = setupPlugins({
        context,
        rawPlugins
    })
    disposers.push(plugins.dispose)
    disposers.push(runtime.execution.apply({
        id: 'client.default-route',
        defaultRoute: defaultExecutionRoute
    }))

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
