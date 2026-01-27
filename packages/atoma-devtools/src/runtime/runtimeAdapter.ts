import type { ClientRuntime } from 'atoma/client'
import type { EntityId } from 'atoma/protocol'
import type { DevtoolsEvent, SyncProvider, HistoryProvider } from './types'
import type { ClientEntry } from './registry'

function emit(entry: ClientEntry, e: DevtoolsEvent): void {
    if (!entry.subscribers.size) return
    for (const sub of entry.subscribers) {
        try {
            sub(e)
        } catch {
            // ignore
        }
    }
}

export function attachRuntime(entry: ClientEntry, runtime: ClientRuntime): void {
    if (entry.runtime === runtime) return

    entry.runtime = runtime

    entry.stopStoreListener?.()
    entry.stopStoreListener = runtime.stores.onStoreCreated((store) => {
        const name = String((store as any)?.name ?? '')
        if (!name) return

        const storeKey = runtime.toStoreKey(name)
        const handle = runtime.handles.get(storeKey)
        if (!handle) return

        if (!entry.storeProviders.has(name)) {
            const snapshot = () => {
                const map = handle.jotaiStore.get(handle.atom) as Map<EntityId, any>
                const sample = Array.from(map.values()).slice(0, 5)
                const approxSize = (() => {
                    try {
                        const str = JSON.stringify(sample)
                        return str ? str.length * 2 : 0
                    } catch {
                        return 0
                    }
                })()

                return {
                    clientId: entry.id,
                    name,
                    count: map.size,
                    approxSize,
                    sample,
                    timestamp: Date.now()
                }
            }

            entry.storeProviders.set(name, { name, snapshot })
            emit(entry, { type: 'store:registered', payload: { clientId: entry.id, name } })
        }

        const indexesRef = handle.indexes
        if (indexesRef && !entry.indexProviders.has(name)) {
            const snapshot = () => {
                const indexes = indexesRef.getIndexSnapshots().map((s: any) => ({
                    field: s.field,
                    type: s.type,
                    dirty: s.dirty,
                    size: s.totalDocs,
                    distinctValues: s.distinctValues,
                    avgSetSize: s.avgSetSize,
                    maxSetSize: s.maxSetSize,
                    minSetSize: s.minSetSize
                }))

                const lastQuery = indexesRef.getLastQueryPlan()

                return {
                    clientId: entry.id,
                    name,
                    indexes,
                    ...(lastQuery ? { lastQuery: lastQuery as any } : {})
                }
            }

            entry.indexProviders.set(name, { name, snapshot })
            emit(entry, { type: 'index:registered', payload: { clientId: entry.id, name } })
        }
    }, { replay: true })
}

export function attachSyncProvider(entry: ClientEntry, provider: SyncProvider): void {
    if (entry.syncProvider === provider) return
    entry.stopSyncListener?.()
    entry.syncProvider = provider
    entry.stopSyncListener = provider.subscribe((e) => {
        emit(entry, e)
    })
}

export function attachHistoryProvider(entry: ClientEntry, provider: HistoryProvider): void {
    entry.historyProvider = provider
}
