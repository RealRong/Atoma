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

type PreparedPluginSetup = Readonly<{
    extensions: ReadonlyArray<Record<string, unknown>>
    disposers: ReadonlyArray<() => void>
}>

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isTokenArray = (value: unknown): value is ReadonlyArray<ServiceToken<unknown>> => {
    return Array.isArray(value) && value.every(item => typeof item === 'symbol')
}

export function isClientPlugin(value: unknown): value is ClientPlugin {
    if (!isPlainObject(value)) return false

    const candidate = value as ClientPluginLike
    if (typeof candidate.id !== 'string' || !candidate.id.trim()) return false
    if (candidate.provides !== undefined && !isTokenArray(candidate.provides)) return false
    if (candidate.requires !== undefined && !isTokenArray(candidate.requires)) return false
    if (candidate.setup !== undefined && typeof candidate.setup !== 'function') return false

    return true
}

export function normalizePlugins(value: ReadonlyArray<unknown>): ClientPlugin[] {
    const output: ClientPlugin[] = []

    for (let index = 0; index < value.length; index++) {
        const plugin = value[index]
        if (!isClientPlugin(plugin)) {
            throw new Error(`[Atoma] plugin 定义非法: index=${index}`)
        }
        output.push({
            ...plugin,
            id: plugin.id.trim()
        })
    }

    return output
}

export function buildPluginList(plugins: ClientPlugin[]): ClientPlugin[] {
    const seenIds = new Set<string>()
    const unique: ClientPlugin[] = []

    for (const plugin of plugins) {
        if (seenIds.has(plugin.id)) {
            throw new Error(`[Atoma] plugin id 冲突: ${plugin.id}`)
        }
        seenIds.add(plugin.id)
        unique.push(plugin)
    }

    return unique
}

function describeToken(token: ServiceToken<unknown>): string {
    return String(token.description ?? token.toString())
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

function assertRequires(plugin: ClientPlugin, context: PluginContext): void {
    const requires = plugin.requires ?? []
    for (const token of requires) {
        if (context.services.resolve(token) === undefined) {
            throw new Error(`[Atoma] plugin requires missing: ${plugin.id} -> ${describeToken(token)}`)
        }
    }
}

function assertProvides(plugin: ClientPlugin, context: PluginContext): void {
    const provides = plugin.provides ?? []
    for (const token of provides) {
        if (context.services.resolve(token) === undefined) {
            throw new Error(`[Atoma] plugin provides missing: ${plugin.id} -> ${describeToken(token)}`)
        }
    }
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

export function setupPlugins(plugins: ClientPlugin[], context: PluginContext): PreparedPluginSetup {
    const extensions: Array<Record<string, unknown>> = []
    const disposers: Array<() => void> = []
    const sortedPlugins = sortPluginsByDependencies(plugins, context)

    for (const plugin of sortedPlugins) {
        assertRequires(plugin, context)
        if (typeof plugin.setup !== 'function') {
            assertProvides(plugin, context)
            continue
        }

        const result = normalizePluginInitResult(plugin.id, plugin.setup(context))
        if (result && isPlainObject(result.extension)) {
            extensions.push(result.extension)
        }

        if (result && typeof result.dispose === 'function') {
            disposers.push(result.dispose)
        }

        assertProvides(plugin, context)
    }

    return {
        extensions,
        disposers
    }
}

export function mountPluginExtensions<
    E extends Record<string, Entity>,
    S extends AtomaSchema<E>
>(
    client: AtomaClient<E, S>,
    extensions: ReadonlyArray<Record<string, unknown>>
): void {
    for (const extension of extensions) {
        Object.assign(client as unknown as Record<string, unknown>, extension)
    }
}
