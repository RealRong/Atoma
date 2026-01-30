import type { ClientPlugin, ClientPluginContext } from 'atoma-client'
import type { ClientMeta, HistoryProvider, SyncProvider } from './types'
import { createClientInspector } from './createClientInspector'
import { attachHistoryProvider, attachSyncProvider } from './runtimeAdapter'
import { getEntryById } from './registry'

export type DevtoolsPluginOptions = Readonly<{
    /**
     * Optional label shown in the devtools UI.
     * - Useful when multiple clients exist on the same page.
     */
    label?: string

    /**
     * Override meta shown in devtools snapshot (rare).
     * - Default uses `ctx.core.meta.storeBackend` (if present) or falls back to local/custom.
     */
    meta?: ClientMeta

    /**
     * Optional sync devtools provider.
     * - If omitted, the plugin will try to read from the devtools registry key "sync".
     */
    syncDevtools?: SyncProvider
}>

const DEVTOOLS_REGISTRY_KEY = Symbol.for('atoma.devtools.registry')

function defaultMeta(ctx: ClientPluginContext): ClientMeta {
    const storeBackend = ctx.core.meta?.storeBackend
    if (storeBackend) {
        const normalizeKind = (k: unknown): ClientMeta['storeBackend']['kind'] => {
            const v = String(k ?? '').trim()
            if (v === 'http' || v === 'indexeddb' || v === 'memory' || v === 'localServer' || v === 'custom') return v
            return 'custom'
        }
        return {
            storeBackend: {
                role: storeBackend.role,
                kind: normalizeKind(storeBackend.kind)
            }
        }
    }
    return { storeBackend: { role: 'local', kind: 'custom' } }
}

function getRegistry(ctx: ClientPluginContext): any | undefined {
    const runtime: any = ctx.core.runtime as any
    return runtime ? runtime[DEVTOOLS_REGISTRY_KEY] : undefined
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
        name: 'atoma-devtools',
        setup: (ctx) => {
            const runtime = ctx.core.runtime
            const registry = getRegistry(ctx)

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
