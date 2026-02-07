import { useMemo } from 'react'
import { executeLocalQuery } from 'atoma-core/query'
import { stableStringify } from 'atoma-shared'
import type { Entity, Query as StoreQuery, StoreApi } from 'atoma-types/core'
import { getStoreBindings } from 'atoma-types/internal'

/**
 * Hook for pure client-side filtering and sorting of arrays.
 * Reuses the core query logic (executeLocalQuery) used by the sync engine.
 *
 * @param data Source array
 * @param query Query spec (filter/sort/page/select)
 * @param store Optional store instance to provide custom matchers (e.g. text search configuration)
 */
export function useLocalQuery<T extends Entity>(
    data: T[],
    query?: StoreQuery<T>,
    store?: StoreApi<T, any>
): T[] {
    const queryKey = useMemo(() => stableStringify(query), [query])

    const matcher = useMemo(() => {
        if (!store) return undefined
        return getStoreBindings(store, 'useLocalQuery').matcher
    }, [store])

    return useMemo(() => {
        if (!data || !data.length) return []
        if (!query) return data

        return executeLocalQuery(data, query, matcher ? { matcher } : undefined).data as T[]
    }, [data, queryKey, matcher])
}
