import type { FindManyOptions, PageInfo, StoreKey } from '../core/types'
import type { ObservabilityContext } from '#observability'
import type { AtomaPatch } from '#protocol'

export type FetchFn = typeof fetch

export type Deferred<T> = {
    resolve: (value: T extends void ? undefined : T) => void
    reject: (reason?: unknown) => void
}

export type QueryEnvelope<T> = { data: T[]; pageInfo?: PageInfo }

export type InFlightTask = {
    deferred: { reject: (reason?: unknown) => void }
}

export type QueryTask<T> = {
    kind: 'query'
    opId: string
    resource: string
    params: FindManyOptions<T> | undefined
    ctx?: ObservabilityContext
    fallback: () => Promise<any>
    deferred: Deferred<QueryEnvelope<T>>
}

export type CreateTask<T> = {
    kind: 'create'
    resource: string
    item: T
    idempotencyKey: string
    deferred: Deferred<any>
    ctx?: ObservabilityContext
}

export type UpdateTask<T> = {
    kind: 'update'
    resource: string
    item: { id: StoreKey; data: T; baseVersion: number; meta?: { idempotencyKey?: string } }
    deferred: Deferred<void>
    ctx?: ObservabilityContext
}

export type PatchTask = {
    kind: 'patch'
    resource: string
    item: { id: StoreKey; patches: AtomaPatch[]; baseVersion: number; timestamp?: number; meta?: { idempotencyKey?: string } }
    deferred: Deferred<void>
    ctx?: ObservabilityContext
}

export type DeleteTask = {
    kind: 'delete'
    resource: string
    item: { id: StoreKey; baseVersion: number; meta?: { idempotencyKey?: string } }
    deferred: Deferred<void>
    ctx?: ObservabilityContext
}

export type WriteTask = CreateTask<any> | UpdateTask<any> | PatchTask | DeleteTask
