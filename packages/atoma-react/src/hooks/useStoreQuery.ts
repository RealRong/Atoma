import { useMemo } from 'react'
import { executeLocalQuery } from 'atoma-core'
import { stableStringify } from 'atoma-shared'
import type { Entity, Query, StoreApi } from 'atoma-core'
import { useStoreSnapshot } from './internal/useStoreSelector'
import { getStoreIndexes, getStoreMatcher } from 'atoma/internal'
import { requireStoreOwner } from './internal/storeInternal'

type UseStoreQueryResultMode = 'entities' | 'ids'

type UseStoreQueryOptions<T extends Entity> =
    & Query<T>
    & { result?: UseStoreQueryResultMode }

type StoreQueryResult<T extends Entity> = {
    ids: Array<T['id']>
    data: T[]
}

function stripResult(options?: UseStoreQueryOptions<any>): Query | undefined {
    if (!options) return undefined
    const { result: _result, ...rest } = options
    return rest
}

function useStoreQueryInternal<T extends Entity, Relations = {}>(
    store: StoreApi<T, Relations>,
    options?: UseStoreQueryOptions<T>
): StoreQueryResult<T> {
    const map = useStoreSnapshot(store, 'useStoreQuery')
    const { client, storeName } = requireStoreOwner(store, 'useStoreQuery')
    const indexes = getStoreIndexes(client, storeName)
    const matcher = getStoreMatcher(client, storeName)

    const query = stripResult(options)
    const queryKey = useMemo(() => stableStringify(query), [query])

    return useMemo(() => {
        const candidate = indexes?.collectCandidates(query?.filter as any)

        if (candidate?.kind === 'empty') return { ids: [] as Array<T['id']>, data: [] as T[] }

        const source = (candidate?.kind === 'candidates')
            ? Array.from(candidate.ids).map(id => map.get(id as any)).filter(Boolean) as T[]
            : Array.from(map.values())

        const shouldSkipFilter =
            candidate?.kind === 'candidates'
            && candidate.exactness === 'exact'
            && query?.filter

        const effectiveQuery = shouldSkipFilter
            ? ({ ...query, filter: undefined } as Query<T>)
            : query

        const shouldSkipApplyQuery =
            effectiveQuery
            && !effectiveQuery.filter
            && !effectiveQuery.sort
            && !effectiveQuery.page
            && !effectiveQuery.select

        const result = shouldSkipApplyQuery || !effectiveQuery
            ? source
            : (executeLocalQuery(source, effectiveQuery as Query<T>, matcher ? { matcher } : undefined).data as T[])

        return { ids: result.map(item => item.id) as Array<T['id']>, data: result }
    }, [map, indexes, matcher, queryKey])
}

export function useStoreQuery<T extends Entity, Relations = {}>(
    store: StoreApi<T, Relations>,
    options: UseStoreQueryOptions<T> & { result: 'ids' }
): Array<T['id']>

export function useStoreQuery<T extends Entity, Relations = {}>(
    store: StoreApi<T, Relations>,
    options?: UseStoreQueryOptions<T>
): T[] {
    const resultMode: UseStoreQueryResultMode = (options as any)?.result || 'entities'
    const baseQuery = stripResult(options)

    const effectiveOptions = resultMode === 'ids'
        ? ({ ...(baseQuery as any), select: undefined } as UseStoreQueryOptions<T>)
        : options

    const res = useStoreQueryInternal(store, effectiveOptions)
    return (resultMode === 'ids' ? (res.ids as Array<T['id']>) : res.data) as any
}
