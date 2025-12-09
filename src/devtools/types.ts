import type { IndexDefinition } from '../core/types'

export type StoreSnapshot = {
    name: string
    count: number
    approxSize: number
    sample: any[]
    timestamp: number
}

export type IndexSnapshot = {
    field: string
    type: IndexDefinition<any>['type']
    size?: number
    distinctValues?: number
    avgSetSize?: number
    maxSetSize?: number
    minSetSize?: number
    sampleTerms?: Array<{ term: string; ids: Array<string | number> }>
    min?: number | string
    max?: number | string
}

export type QueueItem = {
    id: string
    type: string
    retries: number
    nextRetryAt?: number
    error?: string
    payload?: any
}

export type HistoryEntrySummary = {
    index: number
    action: 'add' | 'update' | 'delete'
    id?: string | number
    patchCount?: number
}

export type DevtoolsEvent =
    | { type: 'store-snapshot'; payload: StoreSnapshot }
    | { type: 'index-snapshot'; payload: { name: string; indexes: IndexSnapshot[] } }
    | { type: 'queue-snapshot'; payload: { name: string; pending: QueueItem[]; failed: QueueItem[] } }
    | { type: 'history-snapshot'; payload: { name: string; pointer: number; length: number; entries: HistoryEntrySummary[] } }

export interface DevtoolsBridge {
    emit(event: DevtoolsEvent): void
    subscribe(fn: (e: DevtoolsEvent) => void): () => void
    registerStore?(args: { name: string; snapshot: () => StoreSnapshot }): () => void
    registerIndexManager?(args: { name: string; snapshot: () => IndexSnapshot[] }): () => void
    registerQueue?(args: { name: string; snapshot: () => { pending: QueueItem[]; failed?: QueueItem[] } }): () => void
    registerHistory?(args: { name: string; snapshot: () => { pointer: number; length: number; entries: HistoryEntrySummary[] } }): () => void
}
