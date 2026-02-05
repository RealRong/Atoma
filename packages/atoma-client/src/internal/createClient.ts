import type { Entity } from 'atoma-types/core'
import type { PersistRequest, RuntimeIo } from 'atoma-types/runtime'
import { Runtime } from 'atoma-runtime'
import type { AtomaClient, AtomaSchema, CreateClientOptions, ClientPlugin, PluginContext, PluginInitResult } from 'atoma-types/client'
import { zod } from 'atoma-shared'
import { createClientBuildArgsSchema } from '#client/schemas/createClient'
import { EndpointRegistry } from '../drivers/EndpointRegistry'
import { CapabilitiesRegistry, HandlerChain, PluginRegistry, PluginRuntimeIo } from '../plugins'
import { HttpBackendPlugin, LocalBackendPlugin } from '../defaults'
import { DEVTOOLS_META_KEY, DEVTOOLS_REGISTRY_KEY, type DevtoolsRegistry } from 'atoma-types/devtools'

const { parseOrThrow } = zod

function ensureDevtoolsRegistry(capabilities: CapabilitiesRegistry): DevtoolsRegistry {
    const existing = capabilities.get<DevtoolsRegistry>(DEVTOOLS_REGISTRY_KEY)
    if (existing && typeof existing.get === 'function' && typeof existing.register === 'function') {
        return existing
    }

    const store = new Map<string, any>()
    const subscribers = new Set<(e: { type: 'register' | 'unregister'; key: string }) => void>()

    const registry: DevtoolsRegistry = {
        get: (key) => store.get(String(key)),
        register: (key, value) => {
            const k = String(key)
            store.set(k, value)
            for (const sub of subscribers) {
                try {
                    sub({ type: 'register', key: k })
                } catch {
                    // ignore
                }
            }
            return () => {
                if (store.get(k) !== value) return
                store.delete(k)
                for (const sub of subscribers) {
                    try {
                        sub({ type: 'unregister', key: k })
                    } catch {
                        // ignore
                    }
                }
            }
        },
        subscribe: (fn) => {
            subscribers.add(fn)
            return () => {
                subscribers.delete(fn)
            }
        }
    }

    capabilities.register(DEVTOOLS_REGISTRY_KEY, registry)
    return registry
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
    const args = parseOrThrow(createClientBuildArgsSchema, opt, { prefix: '[Atoma] createClient: ' }) as any

    const client: any = {}

    const endpointRegistry = new EndpointRegistry()
    const pluginRegistry = new PluginRegistry()
    const capabilities = new CapabilitiesRegistry()

    const clientRuntime = new Runtime({
        schema: ((args.schema ?? {}) as S) as any,
        io: {
            executeOps: async () => {
                throw new Error('[Atoma] io not ready')
            },
            query: async () => {
                throw new Error('[Atoma] io not ready')
            }
        } satisfies RuntimeIo
    }) as any

    const pluginContext: PluginContext = {
        clientId: clientRuntime.id,
        endpoints: endpointRegistry,
        capabilities,
        runtime: clientRuntime as any,
        hooks: clientRuntime.hooks
    }

    const plugins: ClientPlugin[] = Array.isArray(args.plugins) ? [...args.plugins] : []

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

    ensureDevtoolsRegistry(capabilities)
    capabilities.register(DEVTOOLS_META_KEY, {
        storeBackend: hasBackend
            ? { role: 'remote', kind: 'http' }
            : { role: 'local', kind: 'custom' }
    })

    for (const plugin of plugins) {
        if (!plugin) continue
        if (typeof plugin.register === 'function') {
            plugin.register(pluginContext, pluginRegistry.register)
        }
    }

    const ioEntries = pluginRegistry.list('io')
    const persistEntries = pluginRegistry.list('persist')
    const readEntries = pluginRegistry.list('read')
    if (!ioEntries.length) throw new Error('[Atoma] io handler missing')
    if (!persistEntries.length) throw new Error('[Atoma] persist handler missing')
    if (!readEntries.length) throw new Error('[Atoma] read handler missing')

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
        persist: async ({ req }: { req: PersistRequest<any> }) => {
            return await persistChain.execute(req, {
                clientId: clientRuntime.id,
                store: String(req.storeName)
            } as any)
        }
    })
    clientRuntime.persistence.setDefaultStrategy('direct')

    const pluginDisposers: Array<() => void> = []

    for (const plugin of plugins) {
        if (!plugin || typeof plugin.init !== 'function') continue
        const result = plugin.init(pluginContext) as PluginInitResult<any> | void
        if (result?.extension && typeof result.extension === 'object') {
            Object.assign(client, result.extension)
        }
        if (typeof result?.dispose === 'function') {
            pluginDisposers.push(result.dispose)
        }
    }

    client.stores = ((name: keyof E & string) => {
        return clientRuntime.stores.ensure(String(name)) as any
    }) as AtomaClient<E, S>['stores']

    client.dispose = () => {
        for (let i = pluginDisposers.length - 1; i >= 0; i--) {
            try {
                pluginDisposers[i]()
            } catch {
                // ignore
            }
        }
        for (const endpoint of endpointRegistry.list()) {
            try {
                endpoint.driver.dispose?.()
            } catch {
                // ignore
            }
        }
    }

    return client as AtomaClient<E, S>
}
