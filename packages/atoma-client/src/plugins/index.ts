import type { Entity } from 'atoma-types/core'
import type { AtomaClient, AtomaSchema } from 'atoma-types/client'
import type {
    EventRegister,
    PluginContext,
    RegisterOperationMiddleware,
} from 'atoma-types/client/plugins'
import { buildPluginList, initPlugins, normalizePlugins, registerPluginHandlers } from './pluginLifecycle'
import { OperationPipeline } from './OperationPipeline'

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

export function setupPlugins({
    context,
    rawPlugins,
    pipeline
}: {
    context: PluginContext
    rawPlugins: ReadonlyArray<unknown>
    pipeline: OperationPipeline
}): PluginsSetup {
    const unregisters: Array<() => void> = []

    const plugins = buildPluginList(normalizePlugins(rawPlugins))

    const register: RegisterOperationMiddleware = (handler, opts) => {
        const unregister = pipeline.register(handler, opts)
        unregisters.push(unregister)
        return unregister
    }

    const registerEvents: EventRegister = (hooks) => {
        const unregister = context.events.register(hooks)
        unregisters.push(unregister)
        return unregister
    }

    registerPluginHandlers(plugins, context, register, registerEvents)

    const init: PluginsSetup['init'] = (client) => {
        return initPlugins(plugins, context, client)
    }

    const dispose = () => {
        for (let i = unregisters.length - 1; i >= 0; i--) {
            safeDispose(unregisters[i])
        }
        unregisters.length = 0
        pipeline.clear()
    }

    return {
        init,
        dispose
    }
}
