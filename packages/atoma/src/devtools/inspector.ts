import type { DevtoolsClientInspector, DevtoolsClientSnapshot } from './types'
import type { ClientEntry } from './registry'

export function inspectorForEntry(entry: ClientEntry): DevtoolsClientInspector {
    const snapshot = (): DevtoolsClientSnapshot => {
        const now = Date.now()
        const sync = entry.syncProvider?.snapshot()
        const history = entry.historyProvider?.snapshot() ?? { scopes: [] }

        return {
            id: entry.id,
            label: entry.label,
            createdAt: entry.createdAt,
            updatedAt: now,
            config: {
                storeBackend: entry.meta.storeBackend
            },
            stores: Array.from(entry.storeProviders.values()).map(p => p.snapshot()),
            indexes: Array.from(entry.indexProviders.values()).map(p => p.snapshot()),
            ...(sync ? { sync } : {}),
            history
        }
    }

    return {
        id: entry.id,
        label: entry.label,
        snapshot,
        subscribe: (fn) => {
            const f = fn
            entry.subscribers.add(f)
            return () => {
                entry.subscribers.delete(f)
            }
        },
        stores: {
            list: () => {
                return Array.from(entry.storeProviders.keys()).map(name => ({ name }))
            },
            snapshot: (name?: string) => {
                if (!name) return Array.from(entry.storeProviders.values()).map(p => p.snapshot())
                const p = entry.storeProviders.get(String(name))
                return p ? [p.snapshot()] : []
            }
        },
        indexes: {
            list: () => {
                return Array.from(entry.indexProviders.keys()).map(name => ({ name }))
            },
            snapshot: (name?: string) => {
                if (!name) return Array.from(entry.indexProviders.values()).map(p => p.snapshot())
                const p = entry.indexProviders.get(String(name))
                return p ? [p.snapshot()] : []
            }
        },
        ...(entry.syncProvider
            ? {
                sync: {
                    snapshot: () => snapshot().sync
                }
            }
            : {}),
        history: {
            snapshot: () => snapshot().history
        }
    }
}
