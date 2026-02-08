import type { Query } from 'atoma-types/core'
import { runQuery, type RunOptions } from './internal/run'

export type QueryLocalOptions = RunOptions

export function queryLocal<T extends object>(
    items: T[],
    query: Query<T>,
    options?: QueryLocalOptions
) {
    return runQuery(items, query, options)
}
