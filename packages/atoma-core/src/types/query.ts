export type Query<T = any> = import('atoma-protocol').Query
export type FilterExpr<T = any> = import('atoma-protocol').FilterExpr
export type SortRule<T = any> = import('atoma-protocol').SortRule
export type PageSpec = import('atoma-protocol').PageSpec
export type PageInfo = import('atoma-protocol').PageInfo

export type FetchPolicy = 'cache-only' | 'network-only' | 'cache-and-network'

export type QueryResult<T, TExplain = unknown> = { data: T[]; pageInfo?: PageInfo; explain?: TExplain }
export type QueryOneResult<T, TExplain = unknown> = { data?: T; explain?: TExplain }
