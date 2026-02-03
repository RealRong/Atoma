export type Query<T = any> = import('../protocol').Query
export type FilterExpr<T = any> = import('../protocol').FilterExpr
export type SortRule<T = any> = import('../protocol').SortRule
export type PageSpec = import('../protocol').PageSpec
export type PageInfo = import('../protocol').PageInfo

export type FetchPolicy = 'cache-only' | 'network-only' | 'cache-and-network'

export type QueryResult<T, TExplain = unknown> = { data: T[]; pageInfo?: PageInfo; explain?: TExplain }
export type QueryOneResult<T, TExplain = unknown> = { data?: T; explain?: TExplain }
