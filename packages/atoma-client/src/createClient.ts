import type { Entity } from 'atoma-types/core'
import type { PersistRequest, PersistResult, RuntimeIo, RuntimeSchema } from 'atoma-types/runtime'
import { Runtime } from 'atoma-runtime'
import type {
    AtomaClient,
    AtomaSchema,
    CreateClientOptions,
    ClientPlugin,
    PluginContext,
    PluginInitResult,
    Register
} from 'atoma-types/client'
import { zod } from 'atoma-shared'
import { createClientBuildArgsSchema } from '#client/schemas/createClient'
import { CapabilitiesRegistry, HandlerChain, PluginRegistry, PluginRuntimeIo } from './plugins'
import { markTerminalResult } from './plugins/HandlerChain'
import { localBackendPlugin } from './defaults/LocalBackendPlugin'
import { DEVTOOLS_META_KEY, DEVTOOLS_REGISTRY_KEY, type DevtoolsRegistry } from 'atoma-types/devtools'

const { parseOrThrow } = zod

const LOCAL_BACKEND_PLUGIN_ID = 'defaults:local-backend'

type MutableClient<
    E extends Record<string, Entity>,
    S extends AtomaSchema<E>
> = AtomaClient<E, S> & Record<string, unknown>

type ClientPluginLike = {
    id?: unknown
    register?: unknown
    init?: unknown
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ensureDevtoolsRegistry(capabilities: CapabilitiesRegistry): (() => void) | undefined {
    const existing = capabilities.get<DevtoolsRegistry>(DEVTOOLS_REGISTRY_KEY)
    if (existing && typeof existing.get === 'function' && typeof existing.register === 'function') {
        return
    }

    const store = new Map<string, unknown>()
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

    return capabilities.register(DEVTOOLS_REGISTRY_KEY, registry)
}

function safeDispose(dispose: (() => void) | undefined): void {
    if (typeof dispose !== 'function') return
    try {
        dispose()
    } catch {
        // ignore
    }
}

function isClientPlugin(value: unknown): value is ClientPlugin {
    if (!isPlainObject(value)) return false

    const candidate = value as ClientPluginLike
    if (candidate.id !== undefined && typeof candidate.id !== 'string') return false
    if (candidate.register !== undefined && typeof candidate.register !== 'function') return false
    if (candidate.init !== undefined && typeof candidate.init !== 'function') return false

    return true
}

function normalizePlugins(value: ReadonlyArray<unknown>): ClientPlugin[] {
    return value.filter(isClientPlugin)
}

function buildPluginList(plugins: ClientPlugin[]): ClientPlugin[] {
    const seenIds = new Set<string>()
    const unique: ClientPlugin[] = []

    for (const plugin of plugins) {
        const id = (typeof plugin.id === 'string' && plugin.id.trim()) ? plugin.id.trim() : undefined
        if (id) {
            if (seenIds.has(id)) continue
            seenIds.add(id)
        }
        unique.push(plugin)
    }

    if (!seenIds.has(LOCAL_BACKEND_PLUGIN_ID)) {
        unique.push(localBackendPlugin())
    }

    return unique
}

function createClientSurface<
    E extends Record<string, Entity>,
    S extends AtomaSchema<E>
>(runtime: Runtime): MutableClient<E, S> {
    const client = {} as MutableClient<E, S>
    client.stores = ((name: keyof E & string) => {
        return runtime.stores.ensure(String(name))
    }) as AtomaClient<E, S>['stores']
    client.dispose = () => {
        // assigned later
    }
    return client
}

function registerPluginHandlers(
    plugins: ClientPlugin[],
    ctx: PluginContext,
    register: Register
): void {
    for (const plugin of plugins) {
        if (typeof plugin.register !== 'function') continue
        plugin.register(ctx, register)
    }
}

function toPluginInitResult(value: unknown): PluginInitResult<unknown> | undefined {
    if (!isPlainObject(value)) return undefined

    const candidate = value as {
        extension?: unknown
        dispose?: unknown
    }

    if (candidate.dispose !== undefined && typeof candidate.dispose !== 'function') {
        return undefined
    }

    return {
        extension: candidate.extension,
        dispose: candidate.dispose as (() => void) | undefined
    }
}

function initPlugins<
    E extends Record<string, Entity>,
    S extends AtomaSchema<E>
>(
    plugins: ClientPlugin[],
    ctx: PluginContext,
    client: MutableClient<E, S>
): Array<() => void> {
    const disposers: Array<() => void> = []

    for (const plugin of plugins) {
        if (typeof plugin.init !== 'function') continue

        const result = toPluginInitResult(plugin.init(ctx))
        if (!result) continue

        if (isPlainObject(result.extension)) {
            Object.assign(client, result.extension)
        }

        if (typeof result.dispose === 'function') {
            disposers.push(result.dispose)
        }
    }

    return disposers
}

function createHandlerChains(pluginRegistry: PluginRegistry): {
    io: HandlerChain<'io'>
    persist: HandlerChain<'persist'>
    read: HandlerChain<'read'>
} {
    const ioEntries = pluginRegistry.list('io')
    const persistEntries = pluginRegistry.list('persist')
    const readEntries = pluginRegistry.list('read')

    if (!ioEntries.length) throw new Error('[Atoma] io handler missing')
    if (!persistEntries.length) throw new Error('[Atoma] persist handler missing')
    if (!readEntries.length) throw new Error('[Atoma] read handler missing')

    return {
        io: new HandlerChain<'io'>(ioEntries, {
            name: 'io',
            terminal: () => markTerminalResult({ results: [] })
        }),
        persist: new HandlerChain<'persist'>(persistEntries, {
            name: 'persist',
            terminal: () => markTerminalResult({ status: 'confirmed' as const })
        }),
        read: new HandlerChain<'read'>(readEntries, {
            name: 'read',
            terminal: () => markTerminalResult({ data: [] })
        })
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
    const args = parseOrThrow(createClientBuildArgsSchema, opt, {
        prefix: '[Atoma] createClient: '
    })

    const pluginRegistry = new PluginRegistry()
    const chains = createHandlerChains(pluginRegistry)
    const capabilities = new CapabilitiesRegistry()
    const runtime = new Runtime({
        schema: args.schema as RuntimeSchema,
        io: {} as RuntimeIo
    })

    runtime.io = new PluginRuntimeIo({
        io: chains.io,
        read: chains.read,
        now: runtime.now,
        clientId: runtime.id
    })
    
    const context: PluginContext = {
        clientId: runtime.id,
        capabilities,
        runtime,
        hooks: runtime.hooks
    }

    const disposers: Array<() => void> = []
    const plugins = buildPluginList(normalizePlugins(args.plugins))

    const unregisterDevtoolsRegistry = ensureDevtoolsRegistry(capabilities)
    if (unregisterDevtoolsRegistry) {
        disposers.push(unregisterDevtoolsRegistry)
    }

    disposers.push(capabilities.register(DEVTOOLS_META_KEY, {
        storeBackend: { role: 'local', kind: 'custom' }
    }))

    const register: Register = (name, handler, opts) => {
        const unregister = pluginRegistry.register(name, handler, opts)
        disposers.push(unregister)
        return unregister
    }

    registerPluginHandlers(plugins, context, register)

    const unregisterDirectStrategy = runtime.strategy.register('direct', {
        persist: async <T extends Entity>({ req }: { req: PersistRequest<T> }): Promise<PersistResult<T>> => {
            return await chains.persist.execute(req, {
                clientId: runtime.id,
                storeName: String(req.storeName)
            }) as PersistResult<T>
        }
    })

    const restoreDefaultStrategy = runtime.strategy.setDefaultStrategy('direct')
    disposers.push(restoreDefaultStrategy)
    disposers.push(unregisterDirectStrategy)

    const client = createClientSurface<E, S>(runtime)
    const pluginInitDisposers = initPlugins(plugins, context, client)
    disposers.push(...pluginInitDisposers)

    let disposed = false
    client.dispose = () => {
        if (disposed) return
        disposed = true

        for (let i = disposers.length - 1; i >= 0; i--) {
            safeDispose(disposers[i])
        }

        pluginRegistry.clear()
    }

    return client
}
