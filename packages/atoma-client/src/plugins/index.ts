import type { Entity } from 'atoma-types/core'
import type { AtomaClient, AtomaSchema } from 'atoma-types/client'
import type { PluginContext, OpsRegister } from 'atoma-types/client/plugins'
import { buildPluginList, initPlugins, normalizePlugins, registerPluginHandlers } from './pluginLifecycle'
import { OpsHandlerRegistry } from './OpsHandlerRegistry'

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
    opsRegistry?: OpsHandlerRegistry
}): PluginsSetup {
    const opsRegistry = args.opsRegistry ?? new OpsHandlerRegistry()
    const unregisters: Array<() => void> = []

    const plugins = buildPluginList(normalizePlugins(args.rawPlugins))

    const register: OpsRegister = (handler, opts) => {
        const unregister = opsRegistry.register(handler, opts)
        unregisters.push(unregister)
        return unregister
    }

    registerPluginHandlers(plugins, args.context, register)

    const init: PluginsSetup['init'] = (client) => {
        return initPlugins(plugins, args.context, client)
    }

    const dispose = () => {
        for (let i = unregisters.length - 1; i >= 0; i--) {
            safeDispose(unregisters[i])
        }
        unregisters.length = 0
        opsRegistry.clear()
    }

    return {
        init,
        dispose
    }
}
