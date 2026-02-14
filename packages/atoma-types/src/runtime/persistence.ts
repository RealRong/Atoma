import type { Entity, ExecutionRoute, OperationContext, Query } from '../core'
import type { EntityId, Version } from '../shared'
import type { StoreHandle } from './handle'

export type WriteStatus = 'confirmed' | 'partial' | 'rejected' | 'enqueued'

export type RuntimeWriteAction = 'create' | 'update' | 'delete' | 'upsert'

export type RuntimeWriteItemMeta = {
    idempotencyKey?: string
    clientTimeMs?: number
    [k: string]: unknown
}

export type RuntimeWriteItemCreate = {
    entityId?: EntityId
    value: unknown
    meta?: RuntimeWriteItemMeta
}

export type RuntimeWriteItemUpdate = {
    entityId: EntityId
    baseVersion: Version
    value: unknown
    meta?: RuntimeWriteItemMeta
}

export type RuntimeWriteItemUpsert = {
    entityId: EntityId
    baseVersion?: Version
    value: unknown
    meta?: RuntimeWriteItemMeta
}

export type RuntimeWriteItemDelete = {
    entityId: EntityId
    baseVersion: Version
    meta?: RuntimeWriteItemMeta
}

export type RuntimeWriteItem =
    | RuntimeWriteItemCreate
    | RuntimeWriteItemUpdate
    | RuntimeWriteItemDelete
    | RuntimeWriteItemUpsert

export type RuntimeWriteOptions = {
    returning?: boolean
    select?: Record<string, boolean>
    merge?: boolean
    upsert?: {
        mode?: 'strict' | 'loose'
    }
}

export type RuntimeWriteEntryBase = {
    entryId: string
    options?: RuntimeWriteOptions
}

export type RuntimeWriteEntryCreate = RuntimeWriteEntryBase & {
    action: 'create'
    item: RuntimeWriteItemCreate
}

export type RuntimeWriteEntryUpdate = RuntimeWriteEntryBase & {
    action: 'update'
    item: RuntimeWriteItemUpdate
}

export type RuntimeWriteEntryDelete = RuntimeWriteEntryBase & {
    action: 'delete'
    item: RuntimeWriteItemDelete
}

export type RuntimeWriteEntryUpsert = RuntimeWriteEntryBase & {
    action: 'upsert'
    item: RuntimeWriteItemUpsert
}

export type RuntimeWriteEntry =
    | RuntimeWriteEntryCreate
    | RuntimeWriteEntryUpdate
    | RuntimeWriteEntryDelete
    | RuntimeWriteEntryUpsert

export type RuntimeWriteError = {
    code: string
    message: string
    kind: string
    retryable?: boolean
    details?: Record<string, unknown>
    cause?: RuntimeWriteError
}

export type RuntimeWriteItemResult =
    | { entryId: string; ok: true; entityId: EntityId; version: Version; data?: unknown }
    | {
        entryId: string
        ok: false
        error: RuntimeWriteError
        current?: { value?: unknown; version?: Version }
    }

export type ExecutionOptions = Readonly<{
    route?: ExecutionRoute
    signal?: AbortSignal
}>

export type WriteRequest<T extends Entity> = Readonly<{
    handle: StoreHandle<T>
    opContext: OperationContext
    entries: ReadonlyArray<RuntimeWriteEntry>
}>

export type WriteOutput<T extends Entity> = Readonly<{
    status: WriteStatus
    results?: ReadonlyArray<RuntimeWriteItemResult>
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

export type Policy = Readonly<{
    implicitFetch?: boolean
    optimistic?: boolean
}>

export interface WritePort {
    write: <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions) => Promise<WriteOutput<T>>
}
