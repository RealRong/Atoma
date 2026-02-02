import { useMemo } from 'react'
import { Query } from 'atoma-core'
import { stableStringify } from 'atoma-shared'
import type { Types } from 'atoma-core'
import { getStoreMatcher } from 'atoma/internal'
import { requireStoreOwner } from './internal/storeInternal'

/**
 * Hook for pure client-side filtering and sorting of arrays.
 * Reuses the core query logic (executeLocalQuery) used by the sync engine.
 *
 * @param data Source array
 * @param query Query spec (filter/sort/page/select)
 * @param store Optional store instance to provide custom matchers (e.g. text search configuration)
 */
export function useLocalQuery<T extends Types.Entity>(
    data: T[],
    query?: Types.Query<T>,
    store?: Types.StoreApi<T, any>
): T[] {
    const queryKey = useMemo(() => stableStringify(query), [query])

    const matcher = useMemo(() => {
        if (!store) return undefined
        const { client, storeName } = requireStoreOwner(store, 'useLocalQuery')
        return getStoreMatcher(client, storeName)
    }, [store])

    return useMemo(() => {
        if (!data || !data.length) return []
        if (!query) return data

        return Query.executeLocalQuery(data, query, matcher ? { matcher } : undefined).data as T[]
    }, [data, queryKey, matcher])
}
