import { useMemo } from 'react'
import { stableStringify } from 'atoma-shared'
import type { Entity, Store, Query as StoreQuery } from 'atoma-types/core'
import { getStoreBindings } from 'atoma-types/internal'
import { useStoreSnapshot } from './internal/useStoreSelector'

type StoreQueryResult<T extends Entity> = Readonly<{
    ids: Array<T['id']>
    data: T[]
}>

function useStoreQueryResult<T extends Entity, Relations = {}>(
    store: Store<T, Relations>,
    query?: StoreQuery<T>
): StoreQueryResult<T> {
    const map = useStoreSnapshot(store, 'useStoreQuery')
    const bindings = getStoreBindings(store, 'useStoreQuery')
    const queryKey = useMemo(() => stableStringify(query), [query])

    return useMemo(() => {
        if (!query) {
            const data = Array.from(map.values()) as T[]
            return {
                ids: data.map((item) => item.id),
                data
            }
        }

        const data = bindings.query(query).data as T[]
        return {
            ids: data.map((item) => item.id),
            data
        }
    }, [bindings, map, queryKey])
}

export function useStoreQuery<T extends Entity, Relations = {}>(
    store: Store<T, Relations>,
    query?: StoreQuery<T>
): T[] {
    return useStoreQueryResult(store, query).data
}

export function useStoreQueryIds<T extends Entity, Relations = {}>(
    store: Store<T, Relations>,
    query?: StoreQuery<T>
): Array<T['id']> {
    return useStoreQueryResult(store, query).ids
}
