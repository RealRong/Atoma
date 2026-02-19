import type { Entity, ExecutionRoute, ActionContext, PageInfo, Query } from '../core'
import type { EntityId, Version } from '../shared'
import type { StoreHandle } from './handle'

export type WriteStatus = 'confirmed' | 'partial' | 'rejected' | 'enqueued'

export type WriteItemMeta = {
    idempotencyKey?: string
    clientTimeMs?: number
    [k: string]: unknown
}

type WriteItemByAction = {
    create: {
        id?: EntityId
        value: unknown
        meta?: WriteItemMeta
    }
    update: {
        id: EntityId
        baseVersion: Version
        value: unknown
        meta?: WriteItemMeta
    }
    upsert: {
        id: EntityId
        expectedVersion?: Version
        value: unknown
        meta?: WriteItemMeta
    }
    delete: {
        id: EntityId
        baseVersion: Version
        meta?: WriteItemMeta
    }
}

export type WriteItem = WriteItemByAction[keyof WriteItemByAction]

export type WriteOptions = {
    returning?: boolean
    select?: Record<string, boolean>
    upsert?: {
        conflict?: 'cas' | 'lww'
        apply?: 'merge' | 'replace'
    }
}

export type WriteEntry = {
    [A in keyof WriteItemByAction]: {
        entryId: string
        action: A
        item: WriteItemByAction[A]
        options?: WriteOptions
    }
}[keyof WriteItemByAction]

export type WriteError = {
    code: string
    message: string
    kind: string
    retryable?: boolean
    details?: Record<string, unknown>
    cause?: WriteError
}

export type WriteItemResult =
    | { entryId: string; ok: true; id: EntityId; version: Version; data?: unknown }
    | {
        entryId: string
        ok: false
        error: WriteError
        current?: { value?: unknown; version?: Version }
    }

export type ExecutionOptions = Readonly<{
    route?: ExecutionRoute
    signal?: AbortSignal
}>

export type WriteRequest<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    context: ActionContext
    entries: ReadonlyArray<WriteEntry>
}>

export type WriteOutput = Readonly<{
    status: WriteStatus
    results?: ReadonlyArray<WriteItemResult>
}>

export type WriteExecutor = <T extends Entity>(
    request: WriteRequest<T>,
    options?: ExecutionOptions
) => Promise<WriteOutput>

export type QueryRequest<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    query: Query<T>
}>

export type ExecutionQueryLocalOutput<T extends Entity = Entity> = Readonly<{
    source: 'local'
    data: T[]
    pageInfo?: PageInfo
}>

export type ExecutionQueryRemoteOutput = Readonly<{
    source: 'remote'
    data: unknown[]
    pageInfo?: PageInfo
}>

export type ExecutionQueryOutput<T extends Entity = Entity> =
    | ExecutionQueryLocalOutput<T>
    | ExecutionQueryRemoteOutput

export type QueryExecutor = <T extends Entity>(
    request: QueryRequest<T>,
    options?: ExecutionOptions
) => Promise<ExecutionQueryOutput<T>>

export type WriteConsistency = Readonly<{
    base: 'cache' | 'fetch'
    commit: 'confirm' | 'optimistic'
}>
