import type { Entity } from '@atoma-js/types/core'
import type {
    AtomaClient,
    AtomaSchema,
    CreateClientOptions,
} from '@atoma-js/types/client'
import { createId, disposeInReverse, safeDispose } from '@atoma-js/shared'
import { Runtime } from '@atoma-js/runtime'
import { PluginContext } from './plugins/PluginContext'
import { setupPlugins } from './plugins/setupPlugins'

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

    const runtime = new Runtime({
        id: createId(),
        stores: options.stores
    })
    const context = new PluginContext(runtime)

    const disposers: Array<() => void> = []
    let pluginSetup: ReturnType<typeof setupPlugins> | null = null
    try {
        pluginSetup = setupPlugins({
            context,
            rawPlugins: userPlugins
        })
        disposers.push(pluginSetup.dispose)
    } catch (error) {
        if (pluginSetup && !disposers.includes(pluginSetup.dispose)) {
            safeDispose(pluginSetup.dispose)
        }
        disposeInReverse(disposers)
        throw error
    }

    if (!pluginSetup) {
        throw new Error('[Atoma] createClient: 插件初始化失败')
    }

    let disposed = false
    const client: AtomaClient<E, S> = {
        stores: ((name: keyof E & string) => runtime.stores.ensure(String(name)) as unknown) as AtomaClient<E, S>['stores'],
        dispose: () => {
            if (disposed) return
            disposed = true
            disposeInReverse(disposers)
        }
    }

    pluginSetup.mount(client)
    return client
}
