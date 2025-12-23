import type { PageInfo, QueryParams } from '../query'
import type { Cursor, EntityId, Version } from '../scalars'
import type { JsonPatch } from '../jsonPatch'
import type { Meta } from '../meta'
import type { StandardError } from '../error'
import type { ChangeBatch } from '../changes'

export type OperationKind = 'query' | 'write' | 'changes.pull'

export type OperationBase = {
    opId: string
    kind: OperationKind
    meta?: Meta
}

export type QueryOp = OperationBase & {
    kind: 'query'
    query: {
        resource: string
        params: QueryParams
    }
}

export type WriteAction = 'create' | 'update' | 'patch' | 'delete'

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
    baseVersion?: Version
    value: unknown
    meta?: WriteItemMeta
}

export type WriteItemPatch = {
    entityId: EntityId
    baseVersion: Version
    patch: JsonPatch[]
    meta?: WriteItemMeta
}

export type WriteItemDelete = {
    entityId: EntityId
    baseVersion?: Version
    meta?: WriteItemMeta
}

export type WriteItem =
    | WriteItemCreate
    | WriteItemUpdate
    | WriteItemPatch
    | WriteItemDelete

export type WriteOptions = {
    returning?: boolean
    select?: Record<string, boolean>
    merge?: boolean
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
}

export type WriteOp = OperationBase & {
    kind: 'write'
    write: {
        resource: string
        action: WriteAction
        items: WriteItem[]
        options?: WriteOptions
    }
}

export type ChangesPullOp = OperationBase & {
    kind: 'changes.pull'
    pull: {
        cursor: Cursor
        limit: number
        resources?: string[]
    }
}

export type Operation = QueryOp | WriteOp | ChangesPullOp

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

export type OperationResult<T = unknown> = ResultOk<T> | ResultErr

export type OpsRequest = {
    meta: Meta
    ops: Operation[]
}

export type OpsResponseData = {
    results: OperationResult[]
}

export type QueryResultData = {
    items: unknown[]
    pageInfo?: PageInfo
}

export type WriteItemResult =
    | { index: number; ok: true; entityId: EntityId; version: Version; data?: unknown }
    | { index: number; ok: false; error: StandardError; current?: { value?: unknown; version?: Version } }

export type WriteResultData = {
    transactionApplied?: boolean
    results: WriteItemResult[]
}

export type ChangesPullResultData = ChangeBatch

