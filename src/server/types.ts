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

export interface BatchQuery {
    resource: string
    requestId?: string
    params: QueryParams
}

export interface BatchRequest {
    action: 'query'
    queries: BatchQuery[]
}

export interface BatchResult<T = any> {
    requestId?: string
    data: T[]
    pageInfo?: PageInfo
    error?: {
        code: string
        message: string
    }
}

export interface BatchResponse<T = any> {
    results: BatchResult<T>[]
}

export interface HandlerConfig {
    adapter: IOrmAdapter
    allowList?: string[]
    onRequest?: (req: BatchRequest, context: any) => Promise<void> | void
    /** 限制单次批量查询数量，防止 DoS，默认不限制 */
    maxQueries?: number
    /** 限制单条查询的最大 limit，默认不限制 */
    maxLimit?: number
}

export interface IOrmAdapter {
    findMany(resource: string, params: QueryParams): Promise<QueryResult>
    batchFindMany?(requests: Array<{ resource: string; params: QueryParams }>): Promise<QueryResult[]>
    isResourceAllowed(resource: string): boolean
}
