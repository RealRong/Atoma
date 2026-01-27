import { useMemo } from 'react'
import { Core } from 'atoma/core'
import type { Entity, FindManyOptions, StoreApi } from 'atoma/core'
import { getStoreMatcher } from 'atoma/internal'
import { requireStoreOwner } from './internal/storeInternal'

type UseLocalQueryOptions<T> = Pick<FindManyOptions<T>, 'where' | 'orderBy' | 'limit' | 'offset'>

/**
 * Hook for pure client-side filtering and sorting of arrays.
 * Reuses the core query logic (applyQuery) used by the sync engine.
 * 
 * @param data Source array
 * @param options Query options (where, orderBy, limit, offset)
 * @param store Optional store instance to provide custom matchers (e.g. text search configuration)
 */
export function useLocalQuery<T extends Entity>(
    data: T[],
    options?: UseLocalQueryOptions<T>,
    store?: StoreApi<T, any>
): T[] {
    const queryKey = useMemo(() => Core.query.stableStringify(options), [options])

    // Resolve matcher from store if provided, for advanced features like fuzzy search
    const matcher = useMemo(() => {
        if (!store) return undefined
        const { client, storeName } = requireStoreOwner(store, 'useLocalQuery')
        return getStoreMatcher(client, storeName)
    }, [store])

    return useMemo(() => {
        if (!data || !data.length) return []
        if (!options) return data

        return Core.query.applyQuery(data, options, matcher ? { matcher } : undefined) as T[]
    }, [data, queryKey, matcher])
}
