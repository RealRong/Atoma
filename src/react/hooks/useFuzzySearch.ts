import { useMemo } from 'react'
import { Core } from '#core'
import type { FuzzySearchOptions, FuzzySearchResult } from '#core'

export function useFuzzySearch<T>(items: T[], q: string, options: FuzzySearchOptions<T>): FuzzySearchResult<T> {
    return useMemo(() => Core.search.fuzzySearch(items, q, options), [items, q, options])
}
