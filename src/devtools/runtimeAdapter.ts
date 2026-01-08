import type { ClientRuntime } from '../client/types'
import type { StoreHandle, StoreKey } from '#core'
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

    entry.stopHandleListener?.()
    entry.stopHandleListener = runtime.onHandleCreated((handle: StoreHandle<any>) => {
        const name = String(handle.storeName || 'store')

        if (!entry.storeProviders.has(name)) {
            const snapshot = () => {
                const map = handle.jotaiStore.get(handle.atom) as Map<StoreKey, any>
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

        if (handle.indexes && !entry.indexProviders.has(name)) {
            const snapshot = () => {
                const indexes = handle.indexes!.getIndexSnapshots().map(s => ({
                    field: s.field,
                    type: s.type,
                    dirty: s.dirty,
                    size: s.totalDocs,
                    distinctValues: s.distinctValues,
                    avgSetSize: s.avgSetSize,
                    maxSetSize: s.maxSetSize,
                    minSetSize: s.minSetSize
                }))

                const lastQuery = handle.indexes!.getLastQueryPlan()

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

