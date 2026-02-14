import type { Entity } from 'atoma-types/core'
import type { AtomaClient, AtomaSchema } from 'atoma-types/client'
import type { PluginContext } from 'atoma-types/client/plugins'
import { buildPluginList, mountPluginExtensions, normalizePlugins, setupPlugins as preparePlugins } from './pluginLifecycle'

function safeDispose(dispose: (() => void) | undefined): void {
    if (typeof dispose !== 'function') return
    try {
        dispose()
    } catch {
        // ignore
    }
}

export type PluginsSetup = Readonly<{
    mount: <E extends Record<string, Entity>, S extends AtomaSchema<E>>(client: AtomaClient<E, S>) => void
    dispose: () => void
}>

export function setupPlugins({
    context,
    rawPlugins
}: {
    context: PluginContext
    rawPlugins: ReadonlyArray<unknown>
}): PluginsSetup {
    const unregisters: Array<() => void> = []
    const plugins = buildPluginList(normalizePlugins(rawPlugins))

    const scopedContext: PluginContext = {
        ...context,
        services: {
            register: (token, value, opts) => {
                const unregister = context.services.register(token, value, opts)
                unregisters.push(unregister)
                return unregister
            },
            resolve: context.services.resolve
        },
        events: {
            register: (hooks) => {
                const unregister = context.events.register(hooks)
                unregisters.push(unregister)
                return unregister
            }
        }
    }

    const prepared = preparePlugins(plugins, scopedContext)

    const mount: PluginsSetup['mount'] = (client) => {
        mountPluginExtensions(client, prepared.extensions)
    }

    const dispose = () => {
        for (let i = prepared.disposers.length - 1; i >= 0; i--) {
            safeDispose(prepared.disposers[i])
        }

        for (let i = unregisters.length - 1; i >= 0; i--) {
            safeDispose(unregisters[i])
        }
        unregisters.length = 0
    }

    return {
        mount,
        dispose
    }
}
