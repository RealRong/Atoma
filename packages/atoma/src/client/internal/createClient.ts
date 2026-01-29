import type { Entity } from '#core'
import { ClientRuntime } from '#client/internal/runtime/ClientRuntime'
import type { Backend } from '#backend'
import { createHttpBackend } from '#backend/http/createHttpBackend'
import type {
    AtomaClient,
    AtomaSchema,
    CreateClientOptions,
} from '#client/types'
import { registerClientRuntime } from '../../internal/runtimeRegistry'
import { ChannelApis } from './infra/ChannelApis'
import { DevtoolsRegistry, DEVTOOLS_REGISTRY_KEY } from './infra/DevtoolsRegistry'
import { IoPipeline } from './infra/IoPipeline'
import { PluginContext } from './infra/PluginContext'
import { PluginSystem } from './infra/PluginSystem'
import { zod } from '#shared'
import { CreateClientSchemas } from '#client/schemas'

const { parseOrThrow } = zod

function isBackendInstance(value: unknown): value is Backend {
    if (!value || typeof value !== 'object') return false
    const backend = value as any
    const store = backend.store
    return Boolean(store && typeof store === 'object' && store.opsClient && typeof store.opsClient.executeOps === 'function')
}

function resolveBackend(input: CreateClientOptions<any, any>['backend']): Backend | undefined {
    if (typeof input === 'undefined') {
        return undefined
    }

    if (typeof input === 'string') {
        return createHttpBackend({ baseURL: input })
    }

    if (isBackendInstance(input)) return input

    return createHttpBackend(input as any)
}

/**
 * Creates an Atoma client instance.
 *
 * This is the unified entry point for creating a client.
 * It handles options validation, backend resolution, and runtime assembly.
 */
export function createClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(opt: CreateClientOptions<E, S>): AtomaClient<E, S> {
    // 1. Validate and parse options
    const args = parseOrThrow(CreateClientSchemas.createClientBuildArgsSchema, opt, { prefix: '[Atoma] createClient: ' }) as any

    // 2. Resolve backend
    const backend = resolveBackend(args.backend)
    const storePersistence = backend?.capabilities?.storePersistence ?? (backend ? 'remote' : 'ephemeral')

    const client: any = {}

    // 3. Initialize IO Pipeline
    const ioPipeline = new IoPipeline(backend)

    // 4. Create Runtime
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

    // 5. Setup Client Key and Stores Proxy
    const clientKey = backend?.key ? String(backend.key) : clientRuntime.id

    const resolveStore = (<Name extends keyof E & string>(name: Name) => {
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
    }) as unknown as AtomaClient<E, S>['stores']

    client.stores = stores
    registerClientRuntime(client, clientRuntime)

    // 6. Setup Infrastructure (Channels, Devtools, Plugin System)
    const disposeListeners = new Set<() => void>()

    const onDispose = (fn: () => void) => {
        disposeListeners.add(fn)
        return () => {
            disposeListeners.delete(fn)
        }
    }

    const devtoolsRegistry = new DevtoolsRegistry()
        ; (clientRuntime as any)[DEVTOOLS_REGISTRY_KEY] = devtoolsRegistry

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

    return client as AtomaClient<E, S>
}
