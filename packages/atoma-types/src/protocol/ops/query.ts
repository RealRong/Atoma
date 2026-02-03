export type CursorToken = string

export type SortRule = { field: string; dir: 'asc' | 'desc' }

export type PageSpec =
    | { mode: 'offset'; limit?: number; offset?: number; includeTotal?: boolean }
    | { mode: 'cursor'; limit?: number; after?: CursorToken; before?: CursorToken }

export type FilterExpr =
    | { op: 'and'; args: FilterExpr[] }
    | { op: 'or'; args: FilterExpr[] }
    | { op: 'not'; arg: FilterExpr }
    | { op: 'eq'; field: string; value: any }
    | { op: 'in'; field: string; values: any[] }
    | { op: 'gt' | 'gte' | 'lt' | 'lte'; field: string; value: number }
    | { op: 'startsWith' | 'endsWith' | 'contains'; field: string; value: string }
    | { op: 'isNull'; field: string }
    | { op: 'exists'; field: string }
    | { op: 'text'; field: string; query: string; mode?: 'match' | 'fuzzy'; distance?: 0 | 1 | 2 }

export type Query = {
    filter?: FilterExpr
    sort?: SortRule[]
    page?: PageSpec
    select?: string[]
    include?: Record<string, Query>
}

export type PageInfo = {
    cursor?: string
    hasNext?: boolean
    total?: number
}
