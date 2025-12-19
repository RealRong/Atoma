import type { AtomaError } from './error'
import type { PageInfo } from '../protocol/batch/pagination'
import type { OrderByRule, CursorToken, Page, QueryParams } from '../protocol/batch/query'
import type { WriteOptions } from '../protocol/batch/types'

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

export type OrmTransactionContext = unknown

export type OrmTransactionArgs = {
    orm: IOrmAdapter
    tx: OrmTransactionContext
}

export interface IOrmAdapter {
    findMany(resource: string, params: QueryParams): Promise<QueryResult>
    batchFindMany?(requests: Array<{ resource: string; params: QueryParams }>): Promise<QueryResult[]>
    transaction<T>(fn: (args: OrmTransactionArgs) => Promise<T>): Promise<T>
    create?(resource: string, data: any, options?: WriteOptions): Promise<QueryResultOne>
    update?(resource: string, data: any, options?: WriteOptions & { where?: Record<string, any> }): Promise<QueryResultOne>
    patch?(
        resource: string,
        item: { id: any; patches: any[]; baseVersion?: number; timestamp?: number },
        options?: WriteOptions
    ): Promise<QueryResultOne>
    delete?(resource: string, whereOrId: any, options?: WriteOptions): Promise<QueryResultOne>
    bulkCreate?(resource: string, items: any[], options?: WriteOptions): Promise<QueryResultMany>
    bulkUpdate?(resource: string, items: Array<{ id: any; data: any; baseVersion?: number }>, options?: WriteOptions): Promise<QueryResultMany>
    bulkPatch?(
        resource: string,
        items: Array<{ id: any; patches: any[]; baseVersion?: number; timestamp?: number }>,
        options?: WriteOptions
    ): Promise<QueryResultMany>
    bulkDelete?(resource: string, ids: any[], options?: WriteOptions): Promise<QueryResultMany>
}

export interface OrmAdapterOptions {
    /** 主键/唯一 tie-breaker 字段名，默认 'id' */
    idField?: string
    /** 默认排序（若请求未提供 orderBy）；若未提供则默认按 idField asc */
    defaultOrderBy?: OrderByRule[]
}

export type { StandardError } from '../protocol/error'

export type { OrderByRule, CursorToken, Page, QueryParams } from '../protocol/batch/query'
export type {
    Action,
    WriteOptions,
    BatchOp,
    BatchRequest,
    BatchResult,
    BatchResponse
} from '../protocol/batch'
