export type { CursorToken } from '../shared'

import type { CursorToken } from '../shared'

export type SortRule<T = unknown> = { field: keyof T & string | string; dir: 'asc' | 'desc' }

export type PageSpec =
    | { mode: 'offset'; limit?: number; offset?: number; includeTotal?: boolean }
    | { mode: 'cursor'; limit?: number; after?: CursorToken; before?: CursorToken }

export type FilterExpr<T = unknown> =
    | { op: 'and'; args: FilterExpr<T>[] }
    | { op: 'or'; args: FilterExpr<T>[] }
    | { op: 'not'; arg: FilterExpr<T> }
    | { op: 'eq'; field: keyof T & string | string; value: unknown }
    | { op: 'in'; field: keyof T & string | string; values: unknown[] }
    | { op: 'gt' | 'gte' | 'lt' | 'lte'; field: keyof T & string | string; value: number }
    | { op: 'startsWith' | 'endsWith' | 'contains'; field: keyof T & string | string; value: string }
    | { op: 'isNull'; field: keyof T & string | string }
    | { op: 'exists'; field: keyof T & string | string }
    | {
        op: 'text'
        field: keyof T & string | string
        query: string
        mode?: 'match' | 'fuzzy'
        distance?: 0 | 1 | 2
    }

export type Query<T = unknown> = {
    filter?: FilterExpr<T>
    sort?: SortRule<T>[]
    page?: PageSpec
}

export type PageInfo = {
    cursor?: CursorToken
    hasNext?: boolean
    total?: number
}

export type QueryResult<T> = { data: T[]; pageInfo?: PageInfo }
export type QueryOneResult<T> = { data?: T }
