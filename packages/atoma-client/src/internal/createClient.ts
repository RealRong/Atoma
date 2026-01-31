import type { Entity } from 'atoma-core'
import type { RuntimeIo, RuntimePersistence } from 'atoma-runtime'
import { ClientRuntime } from '#client/internal/runtime/ClientRuntime'
import type { AtomaClient, AtomaSchema, CreateClientOptions } from '#client/types'
import { registerClientRuntime } from './runtimeRegistry'
import { zod } from 'atoma-shared'
import { CreateClientSchemas } from '#client/schemas'
import { EndpointRegistry } from '../drivers/EndpointRegistry'
import { PluginRegistry } from '../plugins/PluginRegistry'
import { HandlerChain } from '../plugins/HandlerChain'
import type { PluginContext } from '../plugins/types'
import { ClientPlugin } from '../plugins/ClientPlugin'
import { RuntimeIoChain } from '../runtime/RuntimeIoChain'
import { RuntimePersistenceChain } from '../runtime/RuntimePersistenceChain'
import { HttpBackendPlugin } from '../defaults/HttpBackendPlugin'
import { RuntimeObserveChain } from '../runtime/RuntimeObserveChain'
import { DefaultObservePlugin } from '../defaults/DefaultObservePlugin'

const { parseOrThrow } = zod

function toSchema<E extends Record<string, Entity>>(schema: AtomaSchema<E> | undefined): AtomaSchema<E> {
    return (schema ?? {}) as AtomaSchema<E>
}

function toPlugins(input?: ReadonlyArray<ClientPlugin>): ClientPlugin[] {
    return Array.isArray(input) ? [...input] : []
}

function createStubIo(): RuntimeIo {
    return {
        executeOps: async () => {
            throw new Error('[Atoma] io not ready')
        },
        query: async () => {
            throw new Error('[Atoma] io not ready')
        },
        write: async () => {
            throw new Error('[Atoma] io not ready')
        }
    }
}

function createStubPersistence(): RuntimePersistence {
    return {
        register: () => {
            throw new Error('[Atoma] persistence not ready')
        },
        persist: async () => {
            throw new Error('[Atoma] persistence not ready')
        }
    }
}

/**
 * Creates an Atoma client instance.
 *
 * This is the unified entry point for creating a client.
 * It handles options validation, plugin assembly, and runtime wiring.
 */
export function createClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(opt: CreateClientOptions<E, S>): AtomaClient<E, S> {
    const args = parseOrThrow(CreateClientSchemas.createClientBuildArgsSchema, opt, { prefix: '[Atoma] createClient: ' }) as any

    const client: any = {}

    const endpointRegistry = new EndpointRegistry()
    const pluginRegistry = new PluginRegistry()

    const schema = toSchema(args.schema as S)
    const clientRuntime = new ClientRuntime({
        schema,
        io: createStubIo(),
        persistence: createStubPersistence(),
        ownerClient: () => client
    })

    const pluginContext: PluginContext = {
        clientId: clientRuntime.id,
        endpoints: endpointRegistry,
        runtime: clientRuntime as any
    }

    const plugins: ClientPlugin[] = [...toPlugins(args.plugins)]

    const backend = args.backend
    if (typeof backend === 'string') {
        plugins.push(new HttpBackendPlugin({ baseURL: backend }))
    } else if (backend && typeof backend === 'object') {
        const baseURL = String((backend as any).baseURL ?? '').trim()
        if (baseURL) {
            plugins.push(new HttpBackendPlugin({ baseURL }))
        }
    }

    plugins.push(new DefaultObservePlugin())

    for (const plugin of plugins) {
        if (!plugin || typeof plugin.setup !== 'function') {
            throw new Error('[Atoma] createClient: plugin 必须提供 setup(ctx, register)')
        }
        plugin.setup(pluginContext, pluginRegistry.register)
    }

    const ioEntries = pluginRegistry.list('io')
    const persistEntries = pluginRegistry.list('persist')
    const readEntries = pluginRegistry.list('read')
    const observeEntries = pluginRegistry.list('observe')
    if (!ioEntries.length) throw new Error('[Atoma] io handler missing')
    if (!persistEntries.length) throw new Error('[Atoma] persist handler missing')
    if (!readEntries.length) throw new Error('[Atoma] read handler missing')
    if (!observeEntries.length) throw new Error('[Atoma] observe handler missing')

    const ioChain = new HandlerChain(ioEntries)
    const persistChain = new HandlerChain(persistEntries)
    const readChain = new HandlerChain(readEntries)

    const runtimeIo = new RuntimeIoChain({
        io: ioChain,
        read: readChain,
        transform: clientRuntime.transform,
        now: clientRuntime.now,
        clientId: clientRuntime.id
    })

    const baseObserve = clientRuntime.observe
    const runtimeObserve = new RuntimeObserveChain({
        entries: observeEntries,
        clientId: clientRuntime.id,
        base: baseObserve
    })

    clientRuntime.io = runtimeIo
    clientRuntime.persistence = new RuntimePersistenceChain({
        chain: persistChain,
        clientId: clientRuntime.id
    })
    clientRuntime.observe = runtimeObserve

    const resolveStore = (<Name extends keyof E & string>(name: Name) => {
        return clientRuntime.stores.ensure(String(name)) as any
    })

    const stores = new Proxy(resolveStore as any, {
        get: (target, prop, receiver) => {
            if (prop === 'then') return undefined
            if (prop === Symbol.toStringTag) return 'AtomaStores'
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
    client.dispose = () => {
        for (const endpoint of endpointRegistry.list()) {
            try {
                endpoint.driver.dispose?.()
            } catch {
                // ignore
            }
        }
    }

    registerClientRuntime(client, clientRuntime)

    return client as AtomaClient<E, S>
}
