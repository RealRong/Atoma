import { useMemo } from 'react'
import { stableStringify } from '@atoma-js/shared'
import type { Entity, Store, Query as StoreQuery } from '@atoma-js/types/core'
import { getStoreBindings } from '@atoma-js/types/internal'
import { useStoreSnapshot } from './internal/useStoreSelector'

export function useStoreQuery<T extends Entity, Relations = {}>(
    store: Store<T, Relations>,
    query?: StoreQuery<T>
): T[] {
    const map = useStoreSnapshot(store, 'useStoreQuery')
    const bindings = getStoreBindings(store, 'useStoreQuery')
    const queryKey = useMemo(() => stableStringify(query), [query])

    return useMemo(() => {
        if (!query) {
            const data = Array.from(map.values()) as T[]
            return data
        }

        const data = bindings.query(query).data as T[]
        return data
    }, [bindings, map, queryKey])
}