import type { Entity } from 'atoma-types/core'
import type { AtomaClient, AtomaSchema } from 'atoma-types/client'
import type {
    EventRegister,
    PluginContext,
    RegisterOperationMiddleware,
    RuntimeExtensionContext,
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

export function setupPlugins(args: {
    context: PluginContext
    runtimeExtensionContext: RuntimeExtensionContext
    rawPlugins: ReadonlyArray<unknown>
    operationPipeline?: OperationPipeline
}): PluginsSetup {
    const operationPipeline = args.operationPipeline ?? new OperationPipeline()
    const unregisters: Array<() => void> = []

    const plugins = buildPluginList(normalizePlugins(args.rawPlugins))

    const register: RegisterOperationMiddleware = (handler, opts) => {
        const unregister = operationPipeline.register(handler, opts)
        unregisters.push(unregister)
        return unregister
    }

    const registerEvents: EventRegister = (hooks) => {
        const unregister = args.context.events.register(hooks)
        unregisters.push(unregister)
        return unregister
    }

    registerPluginHandlers(plugins, args.context, args.runtimeExtensionContext, register, registerEvents)

    const init: PluginsSetup['init'] = (client) => {
        return initPlugins(plugins, args.context, args.runtimeExtensionContext, client)
    }

    const dispose = () => {
        for (let i = unregisters.length - 1; i >= 0; i--) {
            safeDispose(unregisters[i])
        }
        unregisters.length = 0
        operationPipeline.clear()
    }

    return {
        init,
        dispose
    }
}
