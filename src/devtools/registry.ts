import type { AtomaClient } from '../client/types'
import type { ClientRuntime } from '../client/types'
import type { DevtoolsEvent, ClientMeta, SyncProvider, HistoryProvider, DevtoolsIndexManagerSnapshot, DevtoolsStoreSnapshot } from './types'

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

type Registry = {
    enabled: boolean
    byId: Map<string, ClientEntry>
    byClient: WeakMap<object, string>
}

const registry: Registry = {
    enabled: false,
    byId: new Map(),
    byClient: new WeakMap()
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

export function isRegistryEnabled(): boolean {
    return registry.enabled
}

export function enableRegistry(): void {
    registry.enabled = true
}

export function disableRegistry(): void {
    registry.enabled = false
}

export function listEntries(): ClientEntry[] {
    return Array.from(registry.byId.values())
}

export function getEntryById(id: string): ClientEntry | undefined {
    return registry.byId.get(String(id))
}

export function ensureEntry(
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

