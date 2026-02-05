import { useMemo } from 'react'
import { Query } from 'atoma-core'
import { stableStringify } from 'atoma-shared'
import type * as Types from 'atoma-types/core'
import { useStoreSnapshot } from './internal/useStoreSelector'
import { getStoreBindings } from 'atoma-types/internal'

type UseStoreQueryResultMode = 'entities' | 'ids'

type UseStoreQueryOptions<T extends Types.Entity> =
    & Types.Query<T>
    & { result?: UseStoreQueryResultMode }

type StoreQueryResult<T extends Types.Entity> = {
    ids: Array<T['id']>
    data: T[]
}

function stripResult(options?: UseStoreQueryOptions<any>): Types.Query | undefined {
    if (!options) return undefined
    const { result: _result, ...rest } = options
    return rest
}

function useStoreQueryInternal<T extends Types.Entity, Relations = {}>(
    store: Types.StoreApi<T, Relations>,
    options?: UseStoreQueryOptions<T>
): StoreQueryResult<T> {
    const map = useStoreSnapshot(store, 'useStoreQuery')
    const bindings = getStoreBindings(store, 'useStoreQuery')
    const indexes = bindings.indexes
    const matcher = bindings.matcher

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
            ? ({ ...query, filter: undefined } as Types.Query<T>)
            : query

        const shouldSkipApplyQuery =
            effectiveQuery
            && !effectiveQuery.filter
            && !effectiveQuery.sort
            && !effectiveQuery.page
            && !effectiveQuery.select

        const result = shouldSkipApplyQuery || !effectiveQuery
            ? source
            : (Query.executeLocalQuery(source, effectiveQuery as Types.Query<T>, matcher ? { matcher } : undefined).data as T[])

        return { ids: result.map(item => item.id) as Array<T['id']>, data: result }
    }, [map, indexes, matcher, queryKey])
}

export function useStoreQuery<T extends Types.Entity, Relations = {}>(
    store: Types.StoreApi<T, Relations>,
    options: UseStoreQueryOptions<T> & { result: 'ids' }
): Array<T['id']>

export function useStoreQuery<T extends Types.Entity, Relations = {}>(
    store: Types.StoreApi<T, Relations>,
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
