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

export type PageInfo = {
    cursor?: string
    hasNext?: boolean
    total?: number
}

