import type { PageInfo } from '../core/types'

export type OrderByField = { field: string; direction: 'asc' | 'desc' }

export interface QueryParams {
    where?: Record<string, any>
    orderBy?: OrderByField | OrderByField[]
    limit?: number
    offset?: number
    cursor?: string
    select?: Record<string, boolean>
}

export interface QueryResult<T = any> {
    data: T[]
    pageInfo?: PageInfo
}

export interface QueryResultOne<T = any> {
    data?: T
    error?: StandardError
    transactionApplied?: boolean
}

export interface QueryResultMany<T = any> {
    data: T[]
    partialFailures?: Array<{ index: number; error: StandardError }>
    transactionApplied?: boolean
}

export interface BatchQuery {
    resource: string
    requestId?: string
    params: QueryParams
}

export type Action =
    | 'query'
    | 'create'
    | 'update'
    | 'patch'
    | 'delete'
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

export interface BatchRequest {
    action: Action
    /** query 专用 */
    queries?: BatchQuery[]
    /** 写操作资源 */
    resource?: string
    /** create/update/delete 单条或 bulk* 的数据 */
    payload?: any
    /** update/delete 的条件 */
    where?: Record<string, any>
    options?: WriteOptions
    requestId?: string
}

export interface BatchResult<T = any> {
    requestId?: string
    data: T[]
    pageInfo?: PageInfo
    transactionApplied?: boolean
    partialFailures?: Array<{ index: number; error: StandardError }>
    error?: {
        code: string
        message: string
        details?: any
    }
}

export interface BatchResponse<T = any> {
    results: BatchResult<T>[]
}

export interface HandlerConfig {
    adapter: IOrmAdapter
    allowList?: string[]
    onRequest?: (req: BatchRequest, context: any) => Promise<void> | void
    onAuthorize?: (req: BatchRequest, context: any) => Promise<void> | void
    onSuccess?: (res: BatchResponse, req: BatchRequest, context: any) => Promise<void> | void
    onError?: (err: any, req: BatchRequest, context: any) => Promise<void> | void
    /** 限制单次批量查询数量，防止 DoS，默认不限制 */
    maxQueries?: number
    /** 限制单条查询的最大 limit，默认不限制 */
    maxLimit?: number
    /** 限制批量写的最大条数（bulk*） */
    maxBatchSize?: number
    /** 限制 payload 体积（粗略基于 JSON 长度） */
    maxPayloadBytes?: number
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

export type StandardError = {
    code: string
    message: string
    details?: any
}
