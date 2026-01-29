import type { Entity, StoreDataProcessor } from '#core'
import { ClientRuntime } from '#client/internal/runtime/ClientRuntime'
import type { Backend } from '#backend'
import type {
    AtomaClient,
    AtomaSchema,
    ClientPlugin,
} from '#client/types'
import { registerClientRuntime } from '../../internal/runtimeRegistry'
import { ChannelApis } from './infra/ChannelApis'
import { DevtoolsRegistry, DEVTOOLS_REGISTRY_KEY } from './infra/DevtoolsRegistry'
import { IoPipeline } from './infra/IoPipeline'
import { PluginContext } from './infra/PluginContext'
import { PluginSystem } from './infra/PluginSystem'

export function buildAtomaClient<
    const Entities extends Record<string, Entity>,
    const Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
>(args: {
    schema: Schema
    dataProcessor?: StoreDataProcessor<any>
    backend?: Backend
    plugins?: ReadonlyArray<ClientPlugin<any>>
}): AtomaClient<Entities, Schema> {
    const backend = args.backend
    const storePersistence = backend?.capabilities?.storePersistence ?? (backend ? 'remote' : 'ephemeral')

    const client: any = {}

    const ioPipeline = new IoPipeline(backend)

    const clientRuntime = new ClientRuntime({
        schema: args.schema,
        dataProcessor: args.dataProcessor,
        mirrorWritebackToStore: storePersistence === 'durable',
        ownerClient: () => client,
        localOnly: !backend,
        // Important: all store ops go through the I/O pipeline (`channel: 'store'`).
        opsClient: {
            executeOps: (input: any) => ioPipeline.execute({
                channel: 'store',
                ops: input.ops,
                meta: input.meta,
                ...(input.signal ? { signal: input.signal } : {}),
                ...(input.context ? { context: input.context } : {})
            }) as any
        }
    })

    const clientKey = backend?.key ? String(backend.key) : clientRuntime.id

    const resolveStore = (<Name extends keyof Entities & string>(name: Name) => {
        return clientRuntime.stores.ensure(String(name)) as any
    })

    const stores = new Proxy(resolveStore as any, {
        get: (target, prop, receiver) => {
            // Prevent accidental thenable behavior (e.g. `await client.stores`).
            if (prop === 'then') return undefined
            if (prop === Symbol.toStringTag) return 'AtomaStores'

            // Preserve built-in function props (name/length/prototype/call/apply/bind/etc).
            if (typeof prop !== 'string' || prop in target) {
                return Reflect.get(target, prop, receiver)
            }

            return resolveStore(prop as any)
        },
        apply: (_target, _thisArg, argArray) => {
            return resolveStore(argArray[0] as any)
        }
    }) as unknown as AtomaClient<Entities, Schema>['stores']

    client.stores = stores
    registerClientRuntime(client, clientRuntime)

    const disposeListeners = new Set<() => void>()

    const onDispose = (fn: () => void) => {
        disposeListeners.add(fn)
        return () => {
            disposeListeners.delete(fn)
        }
    }

    const devtoolsRegistry = new DevtoolsRegistry()
    ;(clientRuntime as any)[DEVTOOLS_REGISTRY_KEY] = devtoolsRegistry

    const channels = new ChannelApis({
        execute: ioPipeline.execute,
        backend
    })

    const pluginContext = new PluginContext({
        client,
        runtime: clientRuntime as any,
        clientKey,
        io: {
            use: ioPipeline.use
        },
        store: channels.store,
        remote: channels.remote,
        devtools: devtoolsRegistry,
        onDispose
    })

    const ctx = pluginContext.context

    const pluginSystem = new PluginSystem(client, ctx)

    client.use = (plugin: any) => pluginSystem.use(plugin)

    pluginSystem.installAll(args.plugins)

    let disposed = false
    client.dispose = () => {
        if (disposed) return
        disposed = true

        pluginSystem.dispose()

        for (const fn of Array.from(disposeListeners)) {
            try {
                fn()
            } catch {
                // ignore
            }
        }

        try {
            backend?.dispose?.()
        } catch {
            // ignore
        }
    }

    return client as AtomaClient<Entities, Schema>
}
