import { useMemo } from 'react'
import { applyQuery, stableStringify } from '../../core/query'
import type { FindManyOptions } from '../../core/types'
import { resolveStoreMatcher } from '../../core/storeAccessRegistry'
import type { IStore } from '../../core/types'

type UseLocalQueryOptions<T> = Pick<FindManyOptions<T>, 'where' | 'orderBy' | 'limit' | 'offset'>

/**
 * Hook for pure client-side filtering and sorting of arrays.
 * Reuses the core query logic (applyQuery) used by the sync engine.
 * 
 * @param data Source array
 * @param options Query options (where, orderBy, limit, offset)
 * @param store Optional store instance to provide custom matchers (e.g. text search configuration)
 */
export function useLocalQuery<T extends Record<string, any>>(
    data: T[],
    options?: UseLocalQueryOptions<T>,
    store?: IStore<T, any>
): T[] {
    const queryKey = useMemo(() => stableStringify(options), [options])

    // Resolve matcher from store if provided, for advanced features like fuzzy search
    const matcher = useMemo(() => {
        return store ? resolveStoreMatcher(store as any) : undefined
    }, [store])

    return useMemo(() => {
        if (!data || !data.length) return []
        if (!options) return data

        return applyQuery(data, options, matcher ? { matcher } : undefined) as T[]
    }, [data, queryKey, matcher])
}
