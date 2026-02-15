import type { Entity, ExecutionRoute, OperationContext, Query } from '../core'
import type { EntityId, Version } from '../shared'
import type { StoreHandle } from './handle'

export type WriteStatus = 'confirmed' | 'partial' | 'rejected' | 'enqueued'

export type WriteAction = 'create' | 'update' | 'delete' | 'upsert'

export type WriteItemMeta = {
    idempotencyKey?: string
    clientTimeMs?: number
    [k: string]: unknown
}

export type WriteItemCreate = {
    entityId?: EntityId
    value: unknown
    meta?: WriteItemMeta
}

export type WriteItemUpdate = {
    entityId: EntityId
    baseVersion: Version
    value: unknown
    meta?: WriteItemMeta
}

export type WriteItemUpsert = {
    entityId: EntityId
    baseVersion?: Version
    value: unknown
    meta?: WriteItemMeta
}

export type WriteItemDelete = {
    entityId: EntityId
    baseVersion: Version
    meta?: WriteItemMeta
}

export type WriteItem =
    | WriteItemCreate
    | WriteItemUpdate
    | WriteItemDelete
    | WriteItemUpsert

export type WriteOptions = {
    returning?: boolean
    select?: Record<string, boolean>
    merge?: boolean
    upsert?: {
        mode?: 'strict' | 'loose'
    }
}

export type WriteEntryBase = {
    entryId: string
    options?: WriteOptions
}

export type WriteEntryCreate = WriteEntryBase & {
    action: 'create'
    item: WriteItemCreate
}

export type WriteEntryUpdate = WriteEntryBase & {
    action: 'update'
    item: WriteItemUpdate
}

export type WriteEntryDelete = WriteEntryBase & {
    action: 'delete'
    item: WriteItemDelete
}

export type WriteEntryUpsert = WriteEntryBase & {
    action: 'upsert'
    item: WriteItemUpsert
}

export type WriteEntry =
    | WriteEntryCreate
    | WriteEntryUpdate
    | WriteEntryDelete
    | WriteEntryUpsert

export type WriteError = {
    code: string
    message: string
    kind: string
    retryable?: boolean
    details?: Record<string, unknown>
    cause?: WriteError
}

export type WriteItemResult =
    | { entryId: string; ok: true; entityId: EntityId; version: Version; data?: unknown }
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
    opContext: OperationContext
    entries: ReadonlyArray<WriteEntry>
}>

export type WriteOutput<T extends Entity> = Readonly<{
    status: WriteStatus
    results?: ReadonlyArray<WriteItemResult>
}>

export type WriteExecutor = <T extends Entity>(
    request: WriteRequest<T>,
    options?: ExecutionOptions
) => Promise<WriteOutput<T>>

export type QueryRequest<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    query: Query<T>
}>

export type LocalQueryOutput = Readonly<{
    source: 'local'
    data: unknown[]
    pageInfo?: unknown
}>

export type RemoteQueryOutput = Readonly<{
    source: 'remote'
    data: unknown[]
    pageInfo?: unknown
}>

export type QueryOutput = LocalQueryOutput | RemoteQueryOutput

export type QueryExecutor = <T extends Entity>(
    request: QueryRequest<T>,
    options?: ExecutionOptions
) => Promise<QueryOutput>

export type WriteBase = 'cache' | 'fetch'

export type WriteCommit = 'confirm' | 'optimistic'

export type WriteConsistency = Readonly<{
    base: WriteBase
    commit: WriteCommit
}>

export type Consistency = Readonly<Partial<WriteConsistency>>

export interface WritePort {
    write: <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions) => Promise<WriteOutput<T>>
}
