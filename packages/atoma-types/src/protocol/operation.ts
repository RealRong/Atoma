import type { PageInfo, Query } from './query'
import type { Cursor, EntityId, ResourceToken, Version } from './scalars'
import type { Meta } from './meta'
import type { StandardError } from './error'

export type RemoteOpKind = 'query' | 'write' | 'changes.pull'

export type RemoteOpBase = {
    opId: string
    kind: RemoteOpKind
    meta?: Meta
}

export type QueryOp = RemoteOpBase & {
    kind: 'query'
    query: {
        resource: ResourceToken
        query: Query
    }
}

export type WriteAction = 'create' | 'update' | 'delete' | 'upsert'

export type WriteItemMeta = {
    idempotencyKey?: string
    clientTimeMs?: number
    [k: string]: unknown
}

export type WriteItemCreate = {
    id?: EntityId
    value: unknown
    meta?: WriteItemMeta
}

export type WriteItemUpdate = {
    id: EntityId
    baseVersion: Version
    value: unknown
    meta?: WriteItemMeta
}

export type WriteItemUpsert = {
    id: EntityId
    expectedVersion?: Version
    value: unknown
    meta?: WriteItemMeta
}

export type WriteItemDelete = {
    id: EntityId
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
    upsert?: {
        conflict?: 'cas' | 'lww'
        apply?: 'merge' | 'replace'
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

export type WriteOp = RemoteOpBase & {
    kind: 'write'
    write: {
        resource: ResourceToken
        entries: WriteEntry[]
    }
}

export type ChangesPullOp = RemoteOpBase & {
    kind: 'changes.pull'
    pull: {
        cursor: Cursor
        limit: number
        resources?: ResourceToken[]
    }
}

export type RemoteOp = QueryOp | WriteOp | ChangesPullOp

export type ResultOk<T> = {
    opId: string
    ok: true
    data: T
}

export type ResultErr = {
    opId: string
    ok: false
    error: StandardError
}

export type RemoteOpResult<T = unknown> = ResultOk<T> | ResultErr

export type RemoteOpsRequest = {
    meta: Meta
    ops: RemoteOp[]
}

export type RemoteOpsResponseData = {
    results: RemoteOpResult[]
}

export type QueryResultData = {
    data: unknown[]
    pageInfo?: PageInfo
}

export type WriteItemResult =
    | { entryId: string; ok: true; id: EntityId; version: Version; data?: unknown }
    | { entryId: string; ok: false; error: StandardError; current?: { value?: unknown; version?: Version } }

export type WriteResultData = {
    transactionApplied?: boolean
    /**
     * Results are aligned with write.entries by index.
     * results[i] corresponds to write.entries[i].
     */
    results: WriteItemResult[]
}
