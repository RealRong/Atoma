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
    const scopedContext: PluginContext = {
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
            register: (events) => {
                const unregister = context.events.register(events)
                unregisters.push(unregister)
                return unregister
            }
        }
    }

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

    return {
        mount: (client) => {
            prepared.extensions.forEach((extension) => {
                Object.assign(client as unknown as Record<string, unknown>, extension)
            })
        },
        dispose: () => {
            disposeInReverse(prepared.disposers)
            disposeInReverse(unregisters)
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
    const assertResolved = ({
        plugin,
        tokens,
        kind
    }: {
        plugin: ClientPlugin
        tokens: ReadonlyArray<ServiceToken<unknown>>
        kind: 'requires' | 'provides'
    }): void => {
        tokens.forEach((token) => {
            if (context.services.resolve(token) !== undefined) return
            throw new Error(`[Atoma] plugin ${kind} missing: ${plugin.id} -> ${describeToken(token)}`)
        })
    }

    try {
        orderedPlugins.forEach((plugin) => {
            assertResolved({
                plugin,
                tokens: plugin.requires ?? [],
                kind: 'requires'
            })
            if (typeof plugin.setup === 'function') {
                const result = normalizePluginInitResult(plugin.id, plugin.setup(context))
                const extension = result?.extension
                if (isPlainObject(extension)) {
                    extensions.push(extension)
                }
                const dispose = result?.dispose
                if (typeof dispose === 'function') {
                    disposers.push(dispose)
                }
            }
            assertResolved({
                plugin,
                tokens: plugin.provides ?? [],
                kind: 'provides'
            })
        })
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
    plugins.forEach((plugin) => {
        ;(plugin.provides ?? []).forEach((token) => {
            if (context.services.resolve(token) === undefined) return
            available.add(token)
        })
        ;(plugin.requires ?? []).forEach((token) => {
            if (context.services.resolve(token) === undefined) return
            available.add(token)
        })
    })

    const pending = [...plugins]
    const ordered: ClientPlugin[] = []

    while (pending.length > 0) {
        let progressed = false

        for (let index = 0; index < pending.length; index += 1) {
            const plugin = pending[index]
            const ready = (plugin.requires ?? []).every((token) => {
                return available.has(token) || context.services.resolve(token) !== undefined
            })
            if (!ready) continue

            ordered.push(plugin)
            pending.splice(index, 1)
            index -= 1
            progressed = true

            ;(plugin.provides ?? []).forEach((token) => {
                available.add(token)
            })
        }

        if (progressed) continue

        const blocked = pending.map((plugin) => {
            const missingTokens = (plugin.requires ?? []).filter((token) => {
                return !available.has(token) && context.services.resolve(token) === undefined
            })
            return `${plugin.id}(${missingTokens.length ? missingTokens.map(describeToken).join(', ') : 'unknown'})`
        })
        throw new Error(`[Atoma] plugin dependency cycle detected: ${blocked.join(' -> ')}`)
    }

    return ordered
}

function ensureDependencyCoverage(plugins: ReadonlyArray<ClientPlugin>, context: PluginContext): void {
    const providedTokens = new Set<ServiceToken<unknown>>()
    plugins.forEach((plugin) => {
        ;(plugin.provides ?? []).forEach((token) => {
            providedTokens.add(token)
        })
    })

    plugins.forEach((plugin) => {
        ;(plugin.requires ?? []).forEach((token) => {
            if (context.services.resolve(token) !== undefined || providedTokens.has(token)) return
            throw new Error(`[Atoma] plugin requires unresolved token: ${plugin.id} -> ${describeToken(token)}`)
        })
    })
}

function parsePlugins(rawPlugins: ReadonlyArray<unknown>): ClientPlugin[] {
    const seenIds = new Set<string>()
    const plugins: ClientPlugin[] = []

    rawPlugins.forEach((candidate, index) => {
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
    })

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
        const dispose = disposers.pop()
        if (typeof dispose !== 'function') continue
        try {
            dispose()
        } catch {
            // ignore
        }
    }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isTokenArray = (value: unknown): value is ReadonlyArray<ServiceToken<unknown>> => {
    return Array.isArray(value) && value.every(item => typeof item === 'symbol')
}
