import type { ClientRuntime } from 'atoma/client'
import type { ClientMeta, DevtoolsClientInspector, HistoryProvider, SyncProvider } from './types'
import { inspectorForEntry } from './inspector'
import { ensureEntry, removeEntryById } from './registry'
import { attachHistoryProvider, attachRuntime, attachSyncProvider } from './runtimeAdapter'

type CreateClientDevtoolsArgs = {
    runtime: ClientRuntime
    syncDevtools?: SyncProvider
    historyDevtools?: HistoryProvider
    label?: string
    meta: ClientMeta
}

export function createClientInspector(args: CreateClientDevtoolsArgs): DevtoolsClientInspector & { dispose: () => void } {
    const entry = ensureEntry(args.runtime, { id: args.runtime.clientId, label: args.label, meta: args.meta })

    attachRuntime(entry, args.runtime)
    if (args.syncDevtools) attachSyncProvider(entry, args.syncDevtools)
    if (args.historyDevtools) attachHistoryProvider(entry, args.historyDevtools)

    const inspector = inspectorForEntry(entry)

    const dispose = () => {
        try {
            entry.stopStoreListener?.()
        } catch {
            // ignore
        }
        try {
            entry.stopSyncListener?.()
        } catch {
            // ignore
        }
        try {
            removeEntryById(entry.id)
        } catch {
            // ignore
        }

        try {
            entry.subscribers.clear()
        } catch {
            // ignore
        }
        try {
            entry.storeProviders.clear()
        } catch {
            // ignore
        }
        try {
            entry.indexProviders.clear()
        } catch {
            // ignore
        }
    }

    return {
        ...inspector,
        dispose
    }
}
