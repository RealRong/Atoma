export type Query<T = any> = import('../protocol').Query
export type FilterExpr<T = any> = import('../protocol').FilterExpr
export type SortRule<T = any> = import('../protocol').SortRule
export type PageSpec = import('../protocol').PageSpec
export type PageInfo = import('../protocol').PageInfo

export type FetchPolicy = 'cache-only' | 'network-only' | 'cache-and-network'

export type QueryResult<T> = { data: T[]; pageInfo?: PageInfo }
export type QueryOneResult<T> = { data?: T }
