import type { PageInfo } from '../core/types'
import type { AtomaError } from './error'

export type OrderByRule = { field: string; direction: 'asc' | 'desc' }

export type CursorToken = string

export type Page =
    | {
        mode: 'offset'
        limit: number
        offset?: number
        /** 是否返回 total；默认 true（offset 分页通常需要 total） */
        includeTotal?: boolean
    }
    | {
        mode: 'cursor'
        limit: number
        after?: CursorToken
        before?: CursorToken
    }

export interface QueryParams {
    where?: Record<string, any>
    orderBy?: OrderByRule[]
    page?: Page
    select?: Record<string, boolean>
}

export interface QueryResult<T = any> {
    data: T[]
    pageInfo?: PageInfo
}

export interface QueryResultOne<T = any> {
    data?: T
    /**
     * Adapter 错误必须使用 AtomaError（带 brand），以保证对外错误结构可控且不泄露内部异常。
     * 不再接受裸 StandardError 对象。
     */
    error?: AtomaError
    transactionApplied?: boolean
}

export interface QueryResultMany<T = any> {
    data: T[]
    /**
     * partialFailures.error 同样要求 AtomaError。
     */
    partialFailures?: Array<{ index: number; error: AtomaError }>
    transactionApplied?: boolean
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
    transaction?: boolean
    idempotencyKey?: string
    clientVersion?: number
    merge?: boolean
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
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
        payload: any[]
        options?: WriteOptions
    }
    | {
        opId: string
        action: 'bulkUpdate'
        resource: string
        payload: Array<{ id: any; data: any; clientVersion?: number }>
        options?: WriteOptions
    }
    | {
        opId: string
        action: 'bulkPatch'
        resource: string
        payload: Array<{ id: any; patches: any[]; baseVersion?: number; timestamp?: number }>
        options?: WriteOptions
    }
    | {
        opId: string
        action: 'bulkDelete'
        resource: string
        payload: any[]
        options?: WriteOptions
    }

export interface BatchRequest {
    ops: BatchOp[]
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

export interface IOrmAdapter {
    findMany(resource: string, params: QueryParams): Promise<QueryResult>
    batchFindMany?(requests: Array<{ resource: string; params: QueryParams }>): Promise<QueryResult[]>
    create?(resource: string, data: any, options?: WriteOptions): Promise<QueryResultOne>
    update?(resource: string, data: any, options?: WriteOptions & { where?: Record<string, any> }): Promise<QueryResultOne>
    patch?(
        resource: string,
        item: { id: any; patches: any[]; baseVersion?: number; timestamp?: number },
        options?: WriteOptions
    ): Promise<QueryResultOne>
    delete?(resource: string, whereOrId: any, options?: WriteOptions): Promise<QueryResultOne>
    bulkCreate?(resource: string, items: any[], options?: WriteOptions): Promise<QueryResultMany>
    bulkUpdate?(resource: string, items: Array<{ id: any; data: any; clientVersion?: number }>, options?: WriteOptions): Promise<QueryResultMany>
    bulkPatch?(
        resource: string,
        items: Array<{ id: any; patches: any[]; baseVersion?: number; timestamp?: number }>,
        options?: WriteOptions
    ): Promise<QueryResultMany>
    bulkDelete?(resource: string, ids: any[], options?: WriteOptions): Promise<QueryResultMany>
    isResourceAllowed(resource: string): boolean
}

export interface OrmAdapterOptions {
    /** 主键/唯一 tie-breaker 字段名，默认 'id' */
    idField?: string
    /** 默认排序（若请求未提供 orderBy）；若未提供则默认按 idField asc */
    defaultOrderBy?: OrderByRule[]
}

export type StandardError = {
    code: string
    message: string
    details?: any
}
