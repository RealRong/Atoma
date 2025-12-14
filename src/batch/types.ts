import type { FindManyOptions, PageInfo, StoreKey } from '../core/types'
import type { DebugEmitter } from '../observability/debug'

export type FetchFn = typeof fetch

export type Deferred<T> = {
    resolve: (value: T) => void
    reject: (reason?: any) => void
}

export type QueryEnvelope<T> = { data: T[]; pageInfo?: PageInfo }

export type QueryTask<T> = {
    kind: 'query'
    opId: string
    resource: string
    params: FindManyOptions<T> | undefined
    traceId?: string
    debugEmitter?: DebugEmitter
    fallback: () => Promise<any>
    deferred: Deferred<QueryEnvelope<T>>
}

export type CreateTask<T> = {
    kind: 'create'
    resource: string
    item: T
    deferred: Deferred<any>
    traceId?: string
    debugEmitter?: DebugEmitter
}

export type UpdateTask<T> = {
    kind: 'update'
    resource: string
    item: { id: StoreKey; data: T; clientVersion?: any }
    deferred: Deferred<void>
    traceId?: string
    debugEmitter?: DebugEmitter
}

export type PatchTask = {
    kind: 'patch'
    resource: string
    item: { id: StoreKey; patches: any[]; baseVersion?: number; timestamp?: number }
    deferred: Deferred<void>
    traceId?: string
    debugEmitter?: DebugEmitter
}

export type DeleteTask = {
    kind: 'delete'
    resource: string
    id: StoreKey
    deferred: Deferred<void>
    traceId?: string
    debugEmitter?: DebugEmitter
}

export type WriteTask = CreateTask<any> | UpdateTask<any> | PatchTask | DeleteTask

export type BatchOpResult = {
    opId: string
    ok: boolean
    data?: any[]
    pageInfo?: PageInfo
    partialFailures?: Array<{ index: number; error: any }>
    error?: any
}
