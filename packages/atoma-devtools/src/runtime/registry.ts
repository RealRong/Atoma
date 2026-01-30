import type { ClientRuntime } from 'atoma-client'
import type {
    ClientMeta,
    DevtoolsEvent,
    DevtoolsIndexManagerSnapshot,
    DevtoolsStoreSnapshot,
    HistoryProvider,
    SyncProvider
} from './types'

type StoreProvider = {
    name: string
    snapshot: () => DevtoolsStoreSnapshot
}

type IndexProvider = {
    name: string
    snapshot: () => DevtoolsIndexManagerSnapshot
}

export type ClientEntry = {
    id: string
    label?: string
    createdAt: number
    lastSeenAt: number
    meta: ClientMeta
    subscribers: Set<(e: DevtoolsEvent) => void>
    runtime?: ClientRuntime
    storeProviders: Map<string, StoreProvider>
    indexProviders: Map<string, IndexProvider>
    stopStoreListener?: () => void
    syncProvider?: SyncProvider
    stopSyncListener?: () => void
    historyProvider?: HistoryProvider
}

const byId = new Map<string, ClientEntry>()

function getDefaultMeta(): ClientMeta {
    return {
        storeBackend: { role: 'local', kind: 'custom' }
    }
}

export function listEntries(): ClientEntry[] {
    return Array.from(byId.values())
}

export function getEntryById(id: string): ClientEntry | undefined {
    return byId.get(String(id))
}

export function removeEntryById(id: string): void {
    byId.delete(String(id))
}

export function ensureEntry(
    runtime: ClientRuntime,
    args?: { id?: string; label?: string; meta?: ClientMeta }
): ClientEntry {
    const stableId = String(args?.id ?? runtime.id)
    const now = Date.now()

    const existing = byId.get(stableId)
    if (existing) {
        existing.lastSeenAt = now
        if (args?.label) existing.label = String(args.label)
        if (args?.meta) existing.meta = args.meta
        // Ensure runtime is always up-to-date (hot-reload / re-create client).
        existing.runtime = runtime
        return existing
    }

    const entry: ClientEntry = {
        id: stableId,
        label: args?.label ? String(args.label) : undefined,
        createdAt: now,
        lastSeenAt: now,
        meta: args?.meta ?? getDefaultMeta(),
        subscribers: new Set(),
        runtime,
        storeProviders: new Map(),
        indexProviders: new Map()
    }

    byId.set(stableId, entry)
    return entry
}
