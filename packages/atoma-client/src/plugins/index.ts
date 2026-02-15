import type { Entity } from 'atoma-types/core'
import type { AtomaClient, AtomaSchema } from 'atoma-types/client'
import type {
    ClientPlugin,
    PluginContext,
    PluginInitResult,
} from 'atoma-types/client/plugins'
import type { ServiceToken } from 'atoma-types/client/services'

type ClientPluginLike = {
    id?: unknown
    provides?: unknown
    requires?: unknown
    setup?: unknown
}

type PreparedPlugins = {
    extensions: Array<Record<string, unknown>>
    disposers: Array<() => void>
}

export type PluginsSetup = Readonly<{
    mount: <E extends Record<string, Entity>, S extends AtomaSchema<E>>(client: AtomaClient<E, S>) => void
    dispose: () => void
}>

export function setupPlugins({
    context,
    rawPlugins
}: {
    context: PluginContext
    rawPlugins: ReadonlyArray<unknown>
}): PluginsSetup {
    const unregisters: Array<() => void> = []
    const scopedContext = createTrackedContext({
        context,
        unregisters
    })
    let prepared: PreparedPlugins
    try {
        prepared = preparePlugins({
            plugins: parsePlugins(rawPlugins),
            context: scopedContext
        })
    } catch (error) {
        disposeInReverse(unregisters)
        throw error
    }

    const mount: PluginsSetup['mount'] = (client) => {
        for (const extension of prepared.extensions) {
            Object.assign(client as unknown as Record<string, unknown>, extension)
        }
    }

    const dispose = () => {
        disposeInReverse(prepared.disposers)
        disposeInReverse(unregisters)
    }

    return {
        mount,
        dispose
    }
}

function createTrackedContext({
    context,
    unregisters
}: {
    context: PluginContext
    unregisters: Array<() => void>
}): PluginContext {
    return {
        ...context,
        services: {
            register: (token, value, opts) => {
                const unregister = context.services.register(token, value, opts)
                unregisters.push(unregister)
                return unregister
            },
            resolve: context.services.resolve
        },
        events: {
            register: (hooks) => {
                const unregister = context.events.register(hooks)
                unregisters.push(unregister)
                return unregister
            }
        }
    }
}

function preparePlugins({
    plugins,
    context
}: {
    plugins: ReadonlyArray<ClientPlugin>
    context: PluginContext
}): PreparedPlugins {
    const extensions: Array<Record<string, unknown>> = []
    const disposers: Array<() => void> = []
    const orderedPlugins = sortPluginsByDependencies(plugins, context)

    try {
        for (const plugin of orderedPlugins) {
            assertTokensResolved({
                plugin,
                tokens: plugin.requires ?? [],
                kind: 'requires',
                context
            })

            if (typeof plugin.setup === 'function') {
                const result = normalizePluginInitResult(plugin.id, plugin.setup(context))
                if (result && isPlainObject(result.extension)) {
                    extensions.push(result.extension)
                }
                if (result && typeof result.dispose === 'function') {
                    disposers.push(result.dispose)
                }
            }

            assertTokensResolved({
                plugin,
                tokens: plugin.provides ?? [],
                kind: 'provides',
                context
            })
        }
    } catch (error) {
        disposeInReverse(disposers)
        throw error
    }

    return {
        extensions,
        disposers
    }
}

function sortPluginsByDependencies(plugins: ReadonlyArray<ClientPlugin>, context: PluginContext): ClientPlugin[] {
    ensureDependencyCoverage(plugins, context)

    const available = new Set<ServiceToken<unknown>>()
    for (const plugin of plugins) {
        for (const token of plugin.provides ?? []) {
            if (context.services.resolve(token) !== undefined) {
                available.add(token)
            }
        }
        for (const token of plugin.requires ?? []) {
            if (context.services.resolve(token) !== undefined) {
                available.add(token)
            }
        }
    }

    const pending = [...plugins]
    const ordered: ClientPlugin[] = []

    while (pending.length > 0) {
        let progressed = false

        for (let index = 0; index < pending.length; index++) {
            const plugin = pending[index]
            const ready = (plugin.requires ?? []).every(token => {
                return available.has(token) || context.services.resolve(token) !== undefined
            })
            if (!ready) continue

            ordered.push(plugin)
            pending.splice(index, 1)
            index -= 1
            progressed = true

            for (const token of plugin.provides ?? []) {
                available.add(token)
            }
        }

        if (progressed) continue

        const blocked = pending.map(plugin => {
            const missingTokens = (plugin.requires ?? []).filter(token => {
                return !available.has(token) && context.services.resolve(token) === undefined
            })
            const renderedTokens = missingTokens.length
                ? missingTokens.map(token => describeToken(token)).join(', ')
                : 'unknown'
            return `${plugin.id}(${renderedTokens})`
        })
        throw new Error(`[Atoma] plugin dependency cycle detected: ${blocked.join(' -> ')}`)
    }

    return ordered
}

function ensureDependencyCoverage(plugins: ReadonlyArray<ClientPlugin>, context: PluginContext): void {
    const providedTokens = new Set<ServiceToken<unknown>>()
    for (const plugin of plugins) {
        for (const token of plugin.provides ?? []) {
            providedTokens.add(token)
        }
    }

    for (const plugin of plugins) {
        for (const token of plugin.requires ?? []) {
            if (context.services.resolve(token) !== undefined) continue
            if (providedTokens.has(token)) continue
            throw new Error(`[Atoma] plugin requires unresolved token: ${plugin.id} -> ${describeToken(token)}`)
        }
    }
}

function assertTokensResolved({
    plugin,
    tokens,
    kind,
    context
}: {
    plugin: ClientPlugin
    tokens: ReadonlyArray<ServiceToken<unknown>>
    kind: 'requires' | 'provides'
    context: PluginContext
}): void {
    for (const token of tokens) {
        if (context.services.resolve(token) !== undefined) continue
        throw new Error(`[Atoma] plugin ${kind} missing: ${plugin.id} -> ${describeToken(token)}`)
    }
}

function parsePlugins(rawPlugins: ReadonlyArray<unknown>): ClientPlugin[] {
    const seenIds = new Set<string>()
    const plugins: ClientPlugin[] = []

    for (let index = 0; index < rawPlugins.length; index++) {
        const candidate = rawPlugins[index]
        if (!isClientPlugin(candidate)) {
            throw new Error(`[Atoma] plugin 定义非法: index=${index}`)
        }

        const id = candidate.id.trim()
        if (seenIds.has(id)) {
            throw new Error(`[Atoma] plugin id 冲突: ${id}`)
        }
        seenIds.add(id)
        plugins.push({
            ...candidate,
            id
        })
    }

    return plugins
}

function normalizePluginInitResult(pluginId: string, value: unknown): PluginInitResult<unknown> | null {
    if (value === undefined) return null
    if (!isPlainObject(value)) {
        throw new Error(`[Atoma] plugin setup 返回值非法: ${pluginId}`)
    }

    const candidate = value as {
        extension?: unknown
        dispose?: unknown
    }

    if (candidate.dispose !== undefined && typeof candidate.dispose !== 'function') {
        throw new Error(`[Atoma] plugin dispose 必须是函数: ${pluginId}`)
    }

    return {
        extension: candidate.extension,
        dispose: candidate.dispose as (() => void) | undefined
    }
}

function isClientPlugin(value: unknown): value is ClientPlugin {
    if (!isPlainObject(value)) return false

    const candidate = value as ClientPluginLike
    if (typeof candidate.id !== 'string' || !candidate.id.trim()) return false
    if (candidate.provides !== undefined && !isTokenArray(candidate.provides)) return false
    if (candidate.requires !== undefined && !isTokenArray(candidate.requires)) return false
    if (candidate.setup !== undefined && typeof candidate.setup !== 'function') return false

    return true
}

function describeToken(token: ServiceToken<unknown>): string {
    return String(token.description ?? token.toString())
}

function disposeInReverse(disposers: Array<() => void>): void {
    while (disposers.length > 0) {
        safeDispose(disposers.pop())
    }
}

function safeDispose(dispose: (() => void) | undefined): void {
    if (typeof dispose !== 'function') return
    try {
        dispose()
    } catch {
        // ignore
    }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isTokenArray = (value: unknown): value is ReadonlyArray<ServiceToken<unknown>> => {
    return Array.isArray(value) && value.every(item => typeof item === 'symbol')
}
