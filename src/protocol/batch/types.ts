import type { PageInfo } from './pagination'
import type { QueryParams } from './query'
import type { StandardError } from '../error/types'
import type { AtomaPatch } from '../sync/types'

export type WriteItemMeta = {
    idempotencyKey?: string
    [k: string]: any
}

export type Action =
    | 'query'
    | 'bulkCreate'
    | 'bulkUpdate'
    | 'bulkPatch'
    | 'bulkDelete'

export interface WriteOptions {
    select?: Record<string, boolean>
    returning?: boolean
    idempotencyKey?: string
    merge?: boolean
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
}

export type BulkCreateItem<T = any> = {
    data: T
    meta?: WriteItemMeta
}

export type BulkUpdateItem<T = any> = {
    id: any
    data: T
    baseVersion: number
    meta?: WriteItemMeta
}

export type BulkPatchItem = {
    id: any
    patches: AtomaPatch[]
    baseVersion: number
    timestamp?: number
    meta?: WriteItemMeta
}

export type BulkDeleteItem = {
    id: any
    baseVersion: number
    meta?: WriteItemMeta
}

export type BatchOp =
    | {
        opId: string
        action: 'query'
        query: {
            resource: string
            params: QueryParams
        }
    }
    | {
        opId: string
        action: 'bulkCreate'
        resource: string
        payload: BulkCreateItem[]
        options?: WriteOptions
    }
    | {
        opId: string
        action: 'bulkUpdate'
        resource: string
        payload: BulkUpdateItem[]
        options?: WriteOptions
    }
    | {
        opId: string
        action: 'bulkPatch'
        resource: string
        payload: BulkPatchItem[]
        options?: WriteOptions
    }
    | {
        opId: string
        action: 'bulkDelete'
        resource: string
        payload: BulkDeleteItem[]
        options?: WriteOptions
    }

export interface BatchRequest {
    ops: BatchOp[]
    traceId?: string
    requestId?: string
}

export interface BatchResult<T = any> {
    opId: string
    ok: boolean
    data?: T[]
    pageInfo?: PageInfo
    transactionApplied?: boolean
    partialFailures?: Array<{ index: number; error: StandardError }>
    error?: StandardError
}

export interface BatchResponse<T = any> {
    results: BatchResult<T>[]
}
