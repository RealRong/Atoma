import type { Entity } from 'atoma-types/core'
import type {
    AtomaClient,
    AtomaSchema,
    CreateClientOptions,
} from 'atoma-types/client'
import type { Schema } from 'atoma-types/runtime'
import { createId } from 'atoma-shared'
import { Runtime } from 'atoma-runtime'
import { LOCAL_ROUTE, registerLocalRoute } from './execution/registerLocalRoute'
import { createPluginContext } from './plugins/createPluginContext'
import { setupPlugins } from './plugins/setupPlugins'
import { ServiceRegistry } from './plugins/ServiceRegistry'

export { LOCAL_ROUTE } from './execution/registerLocalRoute'

function disposeInReverse(disposers: Array<() => void>): void {
    while (disposers.length > 0) {
        try {
            disposers.pop()?.()
        } catch {
            // ignore
        }
    }
}

export function createClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(options: CreateClientOptions<E, S>): AtomaClient<E, S> {
    if (typeof options !== 'object' || options === null) {
        throw new Error('[Atoma] createClient: options 必须是对象')
    }

    const userPlugins = options.plugins ?? []
    if (!Array.isArray(userPlugins)) {
        throw new Error('[Atoma] createClient: plugins 必须是数组')
    }

    const rawDefaultRoute = options.defaultRoute
    const defaultRoute = rawDefaultRoute === undefined ? LOCAL_ROUTE : String(rawDefaultRoute).trim()
    if (rawDefaultRoute !== undefined && !defaultRoute) {
        throw new Error('[Atoma] createClient: defaultRoute 不能为空')
    }

    const runtime = new Runtime({
        id: createId(),
        schema: (options.schema ?? {}) as Schema
    })
    const context = createPluginContext({
        runtime,
        services: new ServiceRegistry()
    })

    const disposers: Array<() => void> = []
    let pluginSetup: ReturnType<typeof setupPlugins> | null = null
    try {
        disposers.push(registerLocalRoute(runtime))
        pluginSetup = setupPlugins({
            context,
            rawPlugins: userPlugins
        })
        disposers.push(pluginSetup.dispose)
        disposers.push(runtime.execution.apply({
            id: 'client.default-route',
            defaultRoute
        }))
    } catch (error) {
        if (pluginSetup && !disposers.includes(pluginSetup.dispose)) {
            try {
                pluginSetup.dispose()
            } catch {
                // ignore
            }
        }
        disposeInReverse(disposers)
        throw error
    }

    if (!pluginSetup) {
        throw new Error('[Atoma] createClient: 插件初始化失败')
    }

    let disposed = false
    const client: AtomaClient<E, S> = {
        stores: ((name: keyof E & string) => runtime.stores.ensure(String(name))) as AtomaClient<E, S>['stores'],
        dispose: () => {
            if (disposed) return
            disposed = true
            disposeInReverse(disposers)
        }
    }

    pluginSetup.mount(client)
    return client
}
