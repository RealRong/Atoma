import { useMemo } from 'react'
import { stableStringify } from 'atoma-shared'
import type { Entity, Query as StoreQuery, StoreApi } from 'atoma-types/core'
import type { StoreState } from 'atoma-types/runtime'
import { getStoreBindings } from 'atoma-types/internal'

/**
 * Hook for pure client-side filtering and sorting of arrays.
 * Reuses runtime query evaluation logic via RuntimeEngine.
 *
 * @param data Source array
 * @param query Query spec (filter/sort/page/select)
 * @param store Optional store instance to provide custom matchers (e.g. text search configuration)
 */
export function useLocalQuery<T extends Entity>(
    data: T[],
    query: StoreQuery<T>,
    store: StoreApi<T, any>
): T[]

export function useLocalQuery<T extends Entity>(
    data: T[],
    query?: undefined,
    store?: StoreApi<T, any>
): T[]

export function useLocalQuery<T extends Entity>(
    data: T[],
    query?: StoreQuery<T>,
    store?: StoreApi<T, any>
): T[] {
    const queryKey = useMemo(() => stableStringify(query), [query])

    const bindings = useMemo(() => {
        if (!query && !store) return undefined
        if (!store) {
            throw new Error('[Atoma] useLocalQuery: query 模式下必须提供 store（用于获取 RuntimeEngine 绑定）')
        }
        return getStoreBindings(store, 'useLocalQuery')
    }, [store, query])

    const matcher = bindings?.matcher
    const engine = bindings?.engine

    return useMemo(() => {
        if (!data || !data.length) return []
        if (!query) return data
        if (!engine) {
            throw new Error('[Atoma] useLocalQuery: store 缺少 RuntimeEngine 绑定，无法执行 query')
        }

        const mapRef = new Map<T['id'], T>()
        data.forEach(item => {
            mapRef.set(item.id, item)
        })

        const queryState: StoreState<T> = {
            getSnapshot: () => mapRef,
            setSnapshot: () => {},
            subscribe: () => () => {},
            indexes: null,
            matcher,
            commit: () => {},
            applyWriteback: () => {}
        }

        return engine.query.evaluate({
            state: queryState,
            query
        }).data as T[]
    }, [data, engine, query, queryKey, matcher])
}
