import type { Types } from 'atoma-core'
import type { RuntimeIo } from 'atoma-runtime'
import { Runtime } from 'atoma-runtime'
import type { AtomaClient, AtomaSchema, CreateClientOptions } from '#client/types'
import { registerClientRuntime } from './runtimeRegistry'
import { zod } from 'atoma-shared'
import { CreateClientSchemas } from '#client/schemas'
import { EndpointRegistry } from '../drivers/EndpointRegistry'
import { ClientPlugin, HandlerChain, PluginRegistry, PluginRuntimeIo, PluginRuntimeObserve } from '../plugins'
import type { PluginContext } from '../plugins'
import { DefaultObservePlugin, HttpBackendPlugin, LocalBackendPlugin } from '../defaults'

const { parseOrThrow } = zod

function toSchema<E extends Record<string, Types.Entity>>(schema: AtomaSchema<E> | undefined): AtomaSchema<E> {
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
    const E extends Record<string, Types.Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(opt: CreateClientOptions<E, S>): AtomaClient<E, S> {
    const args = parseOrThrow(CreateClientSchemas.createClientBuildArgsSchema, opt, { prefix: '[Atoma] createClient: ' }) as any

    const client: any = {}

    const endpointRegistry = new EndpointRegistry()
    const pluginRegistry = new PluginRegistry()

    const schema = toSchema(args.schema as S)
    
    const clientRuntime = new Runtime({
        schema: schema as any,
        io: createStubIo(),
        ownerClient: () => client
    }) as any

    const pluginContext: PluginContext = {
        clientId: clientRuntime.id,
        endpoints: endpointRegistry,
        runtime: clientRuntime as any
    }

    const plugins: ClientPlugin[] = [...toPlugins(args.plugins)]

    const backend = args.backend
    let hasBackend = false
    if (typeof backend === 'string') {
        plugins.push(new HttpBackendPlugin({ baseURL: backend }))
        hasBackend = true
    } else if (backend && typeof backend === 'object') {
        const baseURL = String((backend as any).baseURL ?? '').trim()
        if (baseURL) {
            plugins.push(new HttpBackendPlugin({ baseURL }))
            hasBackend = true
        }
    }
    if (!hasBackend) {
        plugins.push(new LocalBackendPlugin())
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

    clientRuntime.io = new PluginRuntimeIo({
        io: ioChain,
        read: readChain,
        now: clientRuntime.now,
        clientId: clientRuntime.id
    })

    clientRuntime.persistence.register('direct', {
        persist: async ({ req }) => {
            return await persistChain.execute(req, {
                clientId: clientRuntime.id,
                store: String(req.storeName)
            } as any)
        }
    })

    clientRuntime.observe = new PluginRuntimeObserve({
        entries: observeEntries,
        clientId: clientRuntime.id,
        base: clientRuntime.observe
    })

    client.stores = ((name: keyof E & string) => {
        return clientRuntime.stores.ensure(String(name)) as any
    }) as AtomaClient<E, S>['stores']

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
