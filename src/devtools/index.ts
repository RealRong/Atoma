import type { ClientRuntime } from '../client/types'
import type { AtomaClient } from '../client/types'
import type { StoreHandle, StoreKey } from '#core'

export type DevtoolsStoreSnapshot = {
    clientId: string
    name: string
    count: number
    approxSize: number
    sample: any[]
    timestamp: number
}

export type DevtoolsIndexManagerSnapshot = {
    clientId: string
    name: string
    indexes: Array<{
        field: string
        type: string
        dirty?: boolean
        size?: number
        distinctValues?: number
        avgSetSize?: number
        maxSetSize?: number
        minSetSize?: number
        sampleTerms?: Array<{ term: string; ids: Array<string | number> }>
    }>
    lastQuery?: {
        timestamp: number
        whereFields: string[]
        perField: Array<{
            field: string
            status: 'no_index' | 'unsupported' | 'empty' | 'candidates'
            exactness?: 'exact' | 'superset'
            candidates?: number
        }>
        result: { kind: 'unsupported' | 'empty' | 'candidates'; exactness?: 'exact' | 'superset'; candidates?: number }
    }
}

export type DevtoolsSyncSnapshot = {
    status: { configured: boolean; started: boolean }
    queue?: { pending: number; failed: number }
    lastEventAt?: number
    lastError?: string
}

export type DevtoolsHistorySnapshot = {
    scopes: Array<{ scope: string; canUndo: boolean; canRedo: boolean }>
}

export type DevtoolsClientSnapshot = {
    id: string
    label?: string
    createdAt: number
    updatedAt: number
    config: {
        storeBackend: { role: 'local' | 'remote'; kind: 'http' | 'indexeddb' | 'memory' | 'localServer' | 'custom' }
        syncConfigured: boolean
    }
    stores: DevtoolsStoreSnapshot[]
    indexes: DevtoolsIndexManagerSnapshot[]
    sync: DevtoolsSyncSnapshot
    history: DevtoolsHistorySnapshot
}

export type DevtoolsEvent = {
    type: string
    payload?: any
}

export type DevtoolsClientInspector = {
    id: string
    label?: string
    snapshot: () => DevtoolsClientSnapshot
    subscribe: (fn: (e: DevtoolsEvent) => void) => () => void
    stores: {
        list: () => Array<{ name: string }>
        snapshot: (name?: string) => DevtoolsStoreSnapshot[]
    }
    indexes: {
        list: () => Array<{ name: string }>
        snapshot: (name?: string) => DevtoolsIndexManagerSnapshot[]
    }
    sync: {
        snapshot: () => DevtoolsSyncSnapshot
    }
    history: {
        snapshot: () => DevtoolsHistorySnapshot
    }
}

export type DevtoolsGlobalInspector = {
    enabled: boolean
    clients: {
        list: () => Array<{ id: string; label?: string; createdAt: number; lastSeenAt: number }>
        get: (id: string) => DevtoolsClientInspector
        snapshot: () => { clients: DevtoolsClientSnapshot[] }
    }
}

type ClientMeta = {
    storeBackend: { role: 'local' | 'remote'; kind: 'http' | 'indexeddb' | 'memory' | 'localServer' | 'custom' }
    syncConfigured: boolean
}

type StoreProvider = {
    name: string
    snapshot: () => DevtoolsStoreSnapshot
}

type IndexProvider = {
    name: string
    snapshot: () => DevtoolsIndexManagerSnapshot
}

type SyncProvider = {
    snapshot: () => { queue?: { pending: number; failed: number }; lastEventAt?: number; lastError?: string }
    subscribe: (fn: (e: DevtoolsEvent) => void) => () => void
}

type HistoryProvider = {
    snapshot: () => DevtoolsHistorySnapshot
}

type ClientEntry = {
    id: string
    label?: string
    createdAt: number
    lastSeenAt: number
    client: AtomaClient<any, any>
    meta: ClientMeta
    subscribers: Set<(e: DevtoolsEvent) => void>
    runtime?: ClientRuntime
    storeProviders: Map<string, StoreProvider>
    indexProviders: Map<string, IndexProvider>
    stopHandleListener?: () => void
    syncProvider?: SyncProvider
    stopSyncListener?: () => void
    historyProvider?: HistoryProvider
}

const GLOBAL_HOOK_KEY = '__ATOMA_DEVTOOLS_VNEXT__'

const registry = {
    enabled: false,
    byId: new Map<string, ClientEntry>(),
    byClient: new WeakMap<object, string>()
}

function createClientId(): string {
    const cryptoAny = (globalThis as any)?.crypto
    const uuid = cryptoAny?.randomUUID?.bind(cryptoAny)
    if (typeof uuid === 'function') {
        try {
            return `c_${String(uuid())}`
        } catch {
            // ignore
        }
    }
    return `c_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
}

function getDefaultMeta(client: AtomaClient<any, any>): ClientMeta {
    const status = client.Sync.status()
    return {
        storeBackend: { role: 'local', kind: 'custom' },
        syncConfigured: Boolean(status.configured)
    }
}

function ensureEntry(
    client: AtomaClient<any, any>,
    args?: { id?: string; label?: string; meta?: ClientMeta }
): ClientEntry {
    const existingId = registry.byClient.get(client as any)
    const id = existingId ?? (args?.id ? String(args.id) : createClientId())
    const now = Date.now()

    if (existingId) {
        const entry = registry.byId.get(existingId)!
        entry.lastSeenAt = now
        if (args?.label) entry.label = String(args.label)
        if (args?.meta) entry.meta = args.meta
        return entry
    }

    const entry: ClientEntry = {
        id,
        label: args?.label ? String(args.label) : undefined,
        createdAt: now,
        lastSeenAt: now,
        client,
        meta: args?.meta ?? getDefaultMeta(client),
        subscribers: new Set(),
        storeProviders: new Map(),
        indexProviders: new Map()
    }
    registry.byId.set(id, entry)
    registry.byClient.set(client as any, id)
    return entry
}

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

function attachRuntime(entry: ClientEntry, runtime: ClientRuntime): void {
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

function attachSyncProvider(entry: ClientEntry, provider: SyncProvider): void {
    if (entry.syncProvider === provider) return
    entry.stopSyncListener?.()
    entry.syncProvider = provider
    entry.stopSyncListener = provider.subscribe((e) => {
        emit(entry, e)
    })
}

function attachHistoryProvider(entry: ClientEntry, provider: HistoryProvider): void {
    entry.historyProvider = provider
}

function inspectorForEntry(entry: ClientEntry): DevtoolsClientInspector {
    const snapshot = (): DevtoolsClientSnapshot => {
        const now = Date.now()
        const syncStatus = entry.client.Sync.status()
        const syncExtra = entry.syncProvider?.snapshot()
        const history = entry.historyProvider?.snapshot() ?? { scopes: [] }

        return {
            id: entry.id,
            label: entry.label,
            createdAt: entry.createdAt,
            updatedAt: now,
            config: {
                storeBackend: entry.meta.storeBackend,
                syncConfigured: entry.meta.syncConfigured
            },
            stores: Array.from(entry.storeProviders.values()).map(p => p.snapshot()),
            indexes: Array.from(entry.indexProviders.values()).map(p => p.snapshot()),
            sync: {
                status: syncStatus,
                ...(syncExtra ? syncExtra : {})
            },
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
        sync: {
            snapshot: () => snapshot().sync
        },
        history: {
            snapshot: () => snapshot().history
        }
    }
}

function registerClientFromRuntime(args: {
    client: AtomaClient<any, any>
    runtime?: ClientRuntime
    syncDevtools?: SyncProvider
    historyDevtools?: HistoryProvider
    label?: string
    meta: ClientMeta
}) {
    if (!registry.enabled) return
    const entry = ensureEntry(args.client, { label: args.label, meta: args.meta })
    if (args.runtime) attachRuntime(entry, args.runtime)
    if (args.syncDevtools) attachSyncProvider(entry, args.syncDevtools)
    if (args.historyDevtools) attachHistoryProvider(entry, args.historyDevtools)
}

function installGlobalHook() {
    ;(globalThis as any)[GLOBAL_HOOK_KEY] = {
        registerClient: registerClientFromRuntime
    }
}

function uninstallGlobalHook() {
    try {
        delete (globalThis as any)[GLOBAL_HOOK_KEY]
    } catch {
        ;(globalThis as any)[GLOBAL_HOOK_KEY] = undefined
    }
}

export const devtools = {
    enableGlobal: () => {
        registry.enabled = true
        installGlobalHook()
    },

    global: (): DevtoolsGlobalInspector => {
        return {
            enabled: registry.enabled,
            clients: {
                list: () => {
                    return Array.from(registry.byId.values())
                        .map(c => ({
                            id: c.id,
                            label: c.label,
                            createdAt: c.createdAt,
                            lastSeenAt: c.lastSeenAt
                        }))
                },
                get: (id: string) => {
                    const entry = registry.byId.get(String(id))
                    if (!entry) {
                        throw new Error(`[Atoma Devtools] client not found: ${String(id)}`)
                    }
                    return inspectorForEntry(entry)
                },
                snapshot: () => {
                    const clients = Array.from(registry.byId.values()).map(e => inspectorForEntry(e).snapshot())
                    return { clients }
                }
            }
        }
    },

    inspect: (client: AtomaClient<any, any>, options?: { id?: string; label?: string }): DevtoolsClientInspector => {
        const entry = ensureEntry(client, { id: options?.id, label: options?.label })
        return inspectorForEntry(entry)
    },

    disableGlobal: () => {
        registry.enabled = false
        uninstallGlobalHook()
    }
} as const
