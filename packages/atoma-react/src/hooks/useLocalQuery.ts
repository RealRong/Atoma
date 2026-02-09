import { useMemo } from 'react'
import { stableStringify } from 'atoma-shared'
import { queryItems } from 'atoma-core/query'
import type { Entity, Query as StoreQuery } from 'atoma-types/core'

/**
 * Hook for pure client-side filtering and sorting of arrays.
 * Uses default local query behavior, independent from store/indexes.
 *
 * @param data Source array
 * @param query Query spec (filter/sort/page/select)
 */
export function useLocalQuery<T extends Entity>(
    data: T[],
    query: StoreQuery<T>
): T[]

export function useLocalQuery<T extends Entity>(
    data: T[],
    query?: undefined
): T[]

export function useLocalQuery<T extends Entity>(
    data: T[],
    query?: StoreQuery<T>
): T[] {
    const queryKey = useMemo(() => stableStringify(query), [query])

    return useMemo(() => {
        if (!data || !data.length) return []
        if (!query) return data

        return queryItems(data, query).data as T[]
    }, [data, query, queryKey])
}
