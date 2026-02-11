import type { Entity } from 'atoma-types/core'
import type { AtomaClient, AtomaSchema } from 'atoma-types/client'
import type { PluginContext, Register } from 'atoma-types/client/plugins'
import { buildPluginList, initPlugins, normalizePlugins, registerPluginHandlers } from './pluginLifecycle'
import { PluginRegistry } from './PluginRegistry'

function safeDispose(dispose: (() => void) | undefined): void {
    if (typeof dispose !== 'function') return
    try {
        dispose()
    } catch {
        // ignore
    }
}

export type PluginsSetup = Readonly<{
    init: <E extends Record<string, Entity>, S extends AtomaSchema<E>>(client: AtomaClient<E, S>) => Array<() => void>
    dispose: () => void
}>

export function setupPlugins(args: {
    context: PluginContext
    rawPlugins: ReadonlyArray<unknown>
    pluginRegistry?: PluginRegistry
}): PluginsSetup {
    const pluginRegistry = args.pluginRegistry ?? new PluginRegistry()
    const registerDisposers: Array<() => void> = []

    const plugins = buildPluginList(normalizePlugins(args.rawPlugins))

    const register: Register = (name, handler, opts) => {
        const unregister = pluginRegistry.register(name, handler, opts)
        registerDisposers.push(unregister)
        return unregister
    }

    registerPluginHandlers(plugins, args.context, register)

    const init: PluginsSetup['init'] = (client) => {
        return initPlugins(plugins, args.context, client)
    }

    const dispose = () => {
        for (let i = registerDisposers.length - 1; i >= 0; i--) {
            safeDispose(registerDisposers[i])
        }
        registerDisposers.length = 0
        pluginRegistry.clear()
    }

    return {
        init,
        dispose
    }
}
