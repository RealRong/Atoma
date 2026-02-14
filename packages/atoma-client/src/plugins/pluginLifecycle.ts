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
    return value.filter(isClientPlugin).map(plugin => ({
        ...plugin,
        id: plugin.id.trim()
    }))
}

export function buildPluginList(plugins: ClientPlugin[]): ClientPlugin[] {
    const seenIds = new Set<string>()
    const unique: ClientPlugin[] = []

    for (const plugin of plugins) {
        if (seenIds.has(plugin.id)) continue
        seenIds.add(plugin.id)
        unique.push(plugin)
    }

    return unique
}

function assertRequires(plugin: ClientPlugin, context: PluginContext): void {
    const requires = plugin.requires ?? []
    for (const token of requires) {
        if (!context.services.resolve(token)) {
            throw new Error(`[Atoma] plugin requires missing: ${plugin.id} -> ${String(token.description ?? 'unknown')}`)
        }
    }
}

function assertProvides(plugin: ClientPlugin, context: PluginContext): void {
    const provides = plugin.provides ?? []
    for (const token of provides) {
        if (!context.services.resolve(token)) {
            throw new Error(`[Atoma] plugin provides missing: ${plugin.id} -> ${String(token.description ?? 'unknown')}`)
        }
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

export function setupPlugins(plugins: ClientPlugin[], context: PluginContext): PreparedPluginSetup {
    const extensions: Array<Record<string, unknown>> = []
    const disposers: Array<() => void> = []

    for (const plugin of plugins) {
        assertRequires(plugin, context)
        if (typeof plugin.setup !== 'function') {
            assertProvides(plugin, context)
            continue
        }

        const result = toPluginInitResult(plugin.setup(context))
        if (!result) {
            assertProvides(plugin, context)
            continue
        }

        if (isPlainObject(result.extension)) {
            extensions.push(result.extension)
        }

        if (typeof result.dispose === 'function') {
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
