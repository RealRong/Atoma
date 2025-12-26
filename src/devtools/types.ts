import type { IndexDefinition } from '#core'
import type { DebugEvent } from '#observability'

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
    dirty?: boolean
    size?: number
    distinctValues?: number
    avgSetSize?: number
    maxSetSize?: number
    minSetSize?: number
    sampleTerms?: Array<{ term: string; ids: Array<string | number> }>
    min?: number | string
    max?: number | string
}

export type IndexQueryPlan = {
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

export type IndexSnapshotPayload = {
    name: string
    indexes: IndexSnapshot[]
    lastQuery?: IndexQueryPlan
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
    | { type: 'index-snapshot'; payload: IndexSnapshotPayload }
    | { type: 'queue-snapshot'; payload: { name: string; pending: QueueItem[]; failed: QueueItem[] } }
    | { type: 'history-snapshot'; payload: { name: string; pointer: number; length: number; entries: HistoryEntrySummary[] } }
    | { type: 'debug-event'; payload: DebugEvent }

export interface DevtoolsBridge {
    emit(event: DevtoolsEvent): void
    subscribe(fn: (e: DevtoolsEvent) => void): () => void
    registerStore?(args: { name: string; snapshot: () => StoreSnapshot }): () => void
    registerIndexManager?(args: { name: string; snapshot: () => IndexSnapshotPayload }): () => void
    registerQueue?(args: { name: string; snapshot: () => { pending: QueueItem[]; failed?: QueueItem[] } }): () => void
    registerHistory?(args: { name: string; snapshot: () => { pointer: number; length: number; entries: HistoryEntrySummary[] } }): () => void
}
