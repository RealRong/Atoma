import type { AtomaClient } from '../client/types'

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

export type ClientMeta = {
    storeBackend: { role: 'local' | 'remote'; kind: 'http' | 'indexeddb' | 'memory' | 'localServer' | 'custom' }
    syncConfigured: boolean
}

export type SyncProvider = {
    snapshot: () => { queue?: { pending: number; failed: number }; lastEventAt?: number; lastError?: string }
    subscribe: (fn: (e: DevtoolsEvent) => void) => () => void
}

export type HistoryProvider = {
    snapshot: () => DevtoolsHistorySnapshot
}

export type RegisterClientFromRuntimeArgs = {
    client: AtomaClient<any, any>
    runtime?: import('../client/types').ClientRuntime
    syncDevtools?: SyncProvider
    historyDevtools?: HistoryProvider
    label?: string
    meta: ClientMeta
}

