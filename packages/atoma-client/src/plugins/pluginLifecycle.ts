import type { Entity } from 'atoma-types/core'
import type { AtomaClient, AtomaSchema } from 'atoma-types/client'
import type {
    ClientPlugin,
    EventRegister,
    PluginContext,
    PluginInitResult,
    RegisterOperationMiddleware,
} from 'atoma-types/client/plugins'
import { localBackendPlugin } from '../defaults/LocalBackendPlugin'

const LOCAL_BACKEND_PLUGIN_ID = 'defaults:local-backend'

type ClientPluginLike = {
    id?: unknown
    operations?: unknown
    events?: unknown
    init?: unknown
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isClientPlugin(value: unknown): value is ClientPlugin {
    if (!isPlainObject(value)) return false

    const candidate = value as ClientPluginLike
    if (candidate.id !== undefined && typeof candidate.id !== 'string') return false
    if (candidate.operations !== undefined && typeof candidate.operations !== 'function') return false
    if (candidate.events !== undefined && typeof candidate.events !== 'function') return false
    if (candidate.init !== undefined && typeof candidate.init !== 'function') return false

    return true
}

export function normalizePlugins(value: ReadonlyArray<unknown>): ClientPlugin[] {
    return value.filter(isClientPlugin)
}

export function buildPluginList(plugins: ClientPlugin[]): ClientPlugin[] {
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

export function registerPluginHandlers(
    plugins: ClientPlugin[],
    context: PluginContext,
    register: RegisterOperationMiddleware,
    registerEvents: EventRegister
): void {
    for (const plugin of plugins) {
        if (typeof plugin.operations === 'function') {
            plugin.operations(context, register)
        }
        if (typeof plugin.events === 'function') {
            plugin.events(context, registerEvents)
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

export function initPlugins<
    E extends Record<string, Entity>,
    S extends AtomaSchema<E>
>(
    plugins: ClientPlugin[],
    context: PluginContext,
    client: AtomaClient<E, S>
): Array<() => void> {
    const disposers: Array<() => void> = []

    for (const plugin of plugins) {
        if (typeof plugin.init !== 'function') continue

        const result = toPluginInitResult(plugin.init(context))
        if (!result) continue

        if (isPlainObject(result.extension)) {
            Object.assign(client as unknown as Record<string, unknown>, result.extension)
        }

        if (typeof result.dispose === 'function') {
            disposers.push(result.dispose)
        }
    }

    return disposers
}
