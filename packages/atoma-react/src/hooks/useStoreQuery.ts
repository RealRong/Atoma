import { useMemo } from 'react'
import { stableStringify } from 'atoma-shared'
import type { Entity, IStore, Query as StoreQuery } from 'atoma-types/core'
import type { StoreState } from 'atoma-types/runtime'
import { getStoreBindings } from 'atoma-types/internal'
import { useStoreSnapshot } from './internal/useStoreSelector'

type UseStoreQueryResultMode = 'entities' | 'ids'

type UseStoreQueryOptions<T extends Entity> =
    & StoreQuery<T>
    & { result?: UseStoreQueryResultMode }

type StoreQueryResult<T extends Entity> = {
    ids: Array<T['id']>
    data: T[]
}

function stripResult<T extends Entity>(options?: UseStoreQueryOptions<T>): StoreQuery<T> | undefined {
    if (!options) return undefined
    const { result: _result, ...rest } = options
    return rest
}

function useStoreQueryInternal<T extends Entity, Relations = {}>(
    store: IStore<T, Relations>,
    options?: UseStoreQueryOptions<T>
): StoreQueryResult<T> {
    const map = useStoreSnapshot(store, 'useStoreQuery')
    const bindings = getStoreBindings(store, 'useStoreQuery')
    const indexes = bindings.indexes
    const engine = bindings.engine

    const query = stripResult(options)
    const queryKey = useMemo(() => stableStringify(query), [query])

    return useMemo(() => {
        const source = Array.from(map.values()) as T[]
        if (!query) {
            return {
                ids: source.map(item => item.id) as Array<T['id']>,
                data: source
            }
        }

        const queryState: StoreState<T> = {
            getSnapshot: () => map,
            setSnapshot: () => {},
            subscribe: () => () => {},
            indexes,
            commit: () => {},
            applyWriteback: () => {}
        }

        const result = engine.query.evaluate({
            state: queryState,
            query
        })

        const data = result.data as T[]
        return {
            ids: data.map(item => item.id) as Array<T['id']>,
            data
        }
    }, [engine, indexes, map, queryKey])
}

export function useStoreQuery<T extends Entity, Relations = {}>(
    store: IStore<T, Relations>,
    options: UseStoreQueryOptions<T> & { result: 'ids' }
): Array<T['id']>

export function useStoreQuery<T extends Entity, Relations = {}>(
    store: IStore<T, Relations>,
    options?: UseStoreQueryOptions<T>
): T[] {
    const resultMode: UseStoreQueryResultMode = options?.result ?? 'entities'
    const baseQuery = stripResult(options)

    const effectiveOptions = resultMode === 'ids'
        ? ({ ...(baseQuery ?? {}), select: undefined } as UseStoreQueryOptions<T>)
        : options

    const result = useStoreQueryInternal(store, effectiveOptions)
    return resultMode === 'ids'
        ? result.ids as unknown as T[]
        : result.data
}
