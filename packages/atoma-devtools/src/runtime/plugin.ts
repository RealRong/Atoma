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
     * - Default uses runtime meta (if present) or falls back to local/custom.
     */
    meta?: ClientMeta

    /**
     * Optional sync devtools provider.
     * - If omitted, the plugin will try to read from the devtools registry key "sync".
     */
    syncDevtools?: SyncProvider
}>

const DEVTOOLS_REGISTRY_KEY = Symbol.for('atoma.devtools.registry')
const DEVTOOLS_META_KEY = Symbol.for('atoma.devtools.meta')

function readRuntimeMeta(runtime: any): ClientMeta | undefined {
    const meta = runtime?.[DEVTOOLS_META_KEY]
    const storeBackend = meta?.storeBackend
    if (!storeBackend) return
    const normalizeKind = (k: unknown): ClientMeta['storeBackend']['kind'] => {
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

function defaultMeta(runtime: any): ClientMeta {
    return readRuntimeMeta(runtime) ?? { storeBackend: { role: 'local', kind: 'custom' } }
}

function getRegistry(runtime: any): any | undefined {
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
        id: 'atoma-devtools',
        init: (ctx: ClientPluginContext) => {
            const runtime = ctx.runtime as any
            const registry = getRegistry(runtime)

            const historyDevtools = asHistoryProvider(registry?.get?.('history'))
            const syncDevtools = options.syncDevtools ?? asSyncProvider(registry?.get?.('sync'))

            const inspector = createClientInspector({
                runtime,
                label: options.label,
                meta: options.meta ?? defaultMeta(runtime),
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
