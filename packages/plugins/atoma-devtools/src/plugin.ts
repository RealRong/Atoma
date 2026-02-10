import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import { DEVTOOLS_META_KEY, DEVTOOLS_REGISTRY_KEY, type DevtoolsRegistry, type DevtoolsMeta } from 'atoma-types/devtools'
import type { HistoryProvider, SyncProvider } from './types'
import { createClientInspector } from './runtime/create-client-inspector'
import { attachHistoryProvider, attachSyncProvider } from './runtime/runtime-adapter'
import { getEntryById } from './runtime/registry'

export type DevtoolsPluginOptions = Readonly<{
    /**
     * Optional label shown in the devtools UI.
     * - Useful when multiple clients exist on the same page.
     */
    label?: string

    /**
     * Override meta shown in devtools snapshot (rare).
     * - Default uses runtime meta (if present) or falls back to local/custom.
     */
    meta?: DevtoolsMeta

    /**
     * Optional sync devtools provider.
     * - If omitted, the plugin will try to read from the devtools registry key "sync".
     */
    syncDevtools?: SyncProvider
}>

function readRuntimeMeta(ctx: PluginContext): DevtoolsMeta | undefined {
    const meta = ctx.capabilities.get<DevtoolsMeta>(DEVTOOLS_META_KEY)
    const storeBackend = meta?.storeBackend
    if (!storeBackend) return
    const normalizeKind = (k: unknown): DevtoolsMeta['storeBackend']['kind'] => {
        const v = String(k ?? '').trim()
        if (v === 'http' || v === 'indexeddb' || v === 'memory' || v === 'localServer' || v === 'custom') return v
        return 'custom'
    }
    return {
        storeBackend: {
            role: storeBackend.role === 'remote' ? 'remote' : 'local',
            kind: normalizeKind(storeBackend.kind)
        }
    }
}

function defaultMeta(ctx: PluginContext): DevtoolsMeta {
    return readRuntimeMeta(ctx) ?? { storeBackend: { role: 'local', kind: 'custom' } }
}

function ensureRegistry(ctx: PluginContext): DevtoolsRegistry {
    const existing = ctx.capabilities.get<DevtoolsRegistry>(DEVTOOLS_REGISTRY_KEY)
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

    ctx.capabilities.register(DEVTOOLS_REGISTRY_KEY, registry)
    return registry
}

function asHistoryProvider(input: unknown): HistoryProvider | undefined {
    const snapshot = typeof input === 'function' ? input : (input as any)?.snapshot
    if (typeof snapshot !== 'function') return
    return { snapshot: snapshot.bind(input) }
}

function asSyncProvider(input: unknown): SyncProvider | undefined {
    const snapshot = typeof input === 'function' ? input : (input as any)?.snapshot
    const subscribe = (input as any)?.subscribe
    if (typeof snapshot !== 'function' || typeof subscribe !== 'function') return
    return { snapshot: snapshot.bind(input), subscribe: subscribe.bind(input) }
}

export function devtoolsPlugin(options: DevtoolsPluginOptions = {}): ClientPlugin {
    return {
        id: 'atoma-devtools',
        init: (ctx: PluginContext) => {
            const runtime = ctx.runtime as any
            const registry = ensureRegistry(ctx)

            const historyDevtools = asHistoryProvider(registry?.get?.('history'))
            const syncDevtools = options.syncDevtools ?? asSyncProvider(registry?.get?.('sync'))

            const inspector = createClientInspector({
                runtime,
                label: options.label,
                meta: options.meta ?? defaultMeta(ctx),
                ...(syncDevtools ? { syncDevtools } : {}),
                ...(historyDevtools ? { historyDevtools } : {})
            })

            const stopRegistry = registry?.subscribe?.((e: { type: string; key: string }) => {
                if (e.type !== 'register') return
                const entry = getEntryById(runtime.id)
                if (!entry) return
                if (e.key === 'history') {
                    const provider = asHistoryProvider(registry?.get?.('history'))
                    if (provider) attachHistoryProvider(entry, provider)
                }
                if (e.key === 'sync') {
                    const provider = asSyncProvider(registry?.get?.('sync'))
                    if (provider) attachSyncProvider(entry, provider)
                }
            })

            return {
                dispose: () => {
                    try {
                        stopRegistry?.()
                    } catch {
                        // ignore
                    }
                    inspector.dispose()
                }
            }
        }
    }
}
