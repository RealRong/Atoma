import { useMemo } from 'react'
import type { FuzzySearchOptions, FuzzySearchResult } from '../../core/search'
import { fuzzySearch } from '../../core/search'

export function useFuzzySearch<T>(items: T[], q: string, options: FuzzySearchOptions<T>): FuzzySearchResult<T> {
    return useMemo(() => fuzzySearch(items, q, options), [items, q, options])
}

