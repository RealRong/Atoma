import type { PageInfo, Query } from './query'
import type { Cursor, EntityId, Version } from '../core/scalars'
import type { Meta } from '../core/meta'
import type { StandardError } from '../core/error'
import type { ChangeBatch } from './changes'

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
    /** strict 模式推荐提供；loose 模式可省略 */
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
        /** 默认 'strict' */
        mode?: 'strict' | 'loose'
    }
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
    data: unknown[]
    pageInfo?: PageInfo
    explain?: any
}

export type WriteItemResult =
    | { index: number; ok: true; entityId: EntityId; version: Version; data?: unknown }
    | { index: number; ok: false; error: StandardError; current?: { value?: unknown; version?: Version } }

export type WriteResultData = {
    transactionApplied?: boolean
    results: WriteItemResult[]
}

export type ChangesPullResultData = ChangeBatch
