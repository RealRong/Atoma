import type { ClientPlugin, ClientPluginContext } from 'atoma/client'
import type { ClientMeta, HistoryProvider, SyncProvider } from './types'
import { createClientInspector } from './createClientInspector'

export type DevtoolsPluginOptions = Readonly<{
    /**
     * Optional label shown in the devtools UI.
     * - Useful when multiple clients exist on the same page.
     */
    label?: string

    /**
     * Override meta shown in devtools snapshot (rare).
     * - Default uses `ctx.meta.storeBackend` (if present) or falls back to local/custom.
     */
    meta?: ClientMeta

    /**
     * Optional sync devtools provider.
     * - If omitted, the plugin will try to auto-detect `client.sync.devtools` (from atoma-sync).
     */
    syncDevtools?: SyncProvider
}>

function defaultMeta(ctx: ClientPluginContext): ClientMeta {
    const storeBackend = ctx.meta?.storeBackend
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

function asHistoryProvider(input: unknown): HistoryProvider | undefined {
    const snapshot = (input as any)?.snapshot
    if (typeof snapshot !== 'function') return
    return { snapshot: snapshot.bind(input) }
}

function asSyncProvider(input: unknown): SyncProvider | undefined {
    const snapshot = (input as any)?.snapshot
    const subscribe = (input as any)?.subscribe
    if (typeof snapshot !== 'function' || typeof subscribe !== 'function') return
    return { snapshot: snapshot.bind(input), subscribe: subscribe.bind(input) }
}

export function devtoolsPlugin(options: DevtoolsPluginOptions = {}): ClientPlugin {
    return {
        name: 'atoma-devtools',
        setup: (ctx) => {
            const runtime = ctx.runtime
            const historyDevtools = asHistoryProvider(ctx.historyDevtools)
            const syncDevtools = options.syncDevtools ?? asSyncProvider((ctx.client as any)?.sync?.devtools)

            const inspector = createClientInspector({
                runtime,
                label: options.label,
                meta: options.meta ?? defaultMeta(ctx),
                ...(syncDevtools ? { syncDevtools } : {}),
                ...(historyDevtools ? { historyDevtools } : {})
            })

            return {
                dispose: () => {
                    inspector.dispose()
                }
            }
        }
    }
}
