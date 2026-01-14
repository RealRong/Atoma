export type OrderByRule = { field: string; direction: 'asc' | 'desc' }

export type CursorToken = string

export interface QueryParams {
    where?: Record<string, any>
    /**
     * FindManyOptions 兼容形态：允许单条或数组（服务端/本地实现会统一 normalize 成数组）
     */
    orderBy?: OrderByRule[] | OrderByRule

    /**
     * FindManyOptions 风格分页字段（推荐）：
     * - offset: limit + offset (+ includeTotal)
     * - cursor: after/before
     */
    limit?: number
    offset?: number
    includeTotal?: boolean
    after?: CursorToken
    before?: CursorToken

    /**
     * FindManyOptions 风格字段投影（推荐）
     */
    fields?: string[]
}

export type PageInfo = {
    cursor?: string
    hasNext?: boolean
    total?: number
}

