import { useMemo } from 'react'
import { Core } from 'atoma/core'
import type { Entity, FindManyOptions, StoreApi } from 'atoma/core'
import { unstable_storeHandleManager as storeHandleManager } from 'atoma/core'
import { useStoreSnapshot } from './internal/useStoreSelector'

type UseStoreQuerySelect = 'entities' | 'ids'

type UseStoreQueryOptions<T extends Entity> =
    & Pick<FindManyOptions<T>, 'where' | 'orderBy' | 'limit' | 'offset'>
    & { select?: UseStoreQuerySelect }

type StoreQueryResult<T extends Entity> = {
    ids: Array<T['id']>
    data: T[]
}

function useStoreQueryInternal<T extends Entity, Relations = {}>(
    store: StoreApi<T, Relations>,
    options?: UseStoreQueryOptions<T>
): StoreQueryResult<T> {
    const map = useStoreSnapshot(store, 'useStoreQuery')
    const indexes = storeHandleManager.getStoreIndexes(store, 'useStoreQuery')
    const matcher = storeHandleManager.getStoreMatcher(store, 'useStoreQuery')
    const queryKey = useMemo(() => Core.query.stableStringify(options), [options])

    return useMemo(() => {
        const candidate = indexes?.collectCandidates(options?.where as any)

        if (candidate?.kind === 'empty') return { ids: [] as Array<T['id']>, data: [] as T[] }

        const source = (candidate?.kind === 'candidates')
            ? Array.from(candidate.ids).map(id => map.get(id)).filter(Boolean) as T[]
            : Array.from(map.values())

        const shouldSkipWhere =
            candidate?.kind === 'candidates'
            && candidate.exactness === 'exact'
            && options?.where
            && typeof options.where === 'object'
            && typeof options.where !== 'function'

        const effectiveOptions = shouldSkipWhere
            ? ({ ...options, where: undefined } as any)
            : options

        const shouldSkipApplyQuery =
            effectiveOptions
            && !effectiveOptions.where
            && !effectiveOptions.orderBy
            && effectiveOptions.limit === undefined
            && effectiveOptions.offset === undefined

        const result: T[] = shouldSkipApplyQuery
            ? source
            : (Core.query.applyQuery(source, effectiveOptions as any, matcher ? { matcher } : undefined) as T[])

        return { ids: result.map(item => item.id) as Array<T['id']>, data: result }
    }, [map, indexes, matcher, queryKey])
}

export function useStoreQuery<T extends Entity, Relations = {}>(
    store: StoreApi<T, Relations>,
    options: UseStoreQueryOptions<T> & { select: 'ids' }
): Array<T['id']>

export function useStoreQuery<T extends Entity, Relations = {}>(
    store: StoreApi<T, Relations>,
    options?: UseStoreQueryOptions<T>
): T[] {
    const select: UseStoreQuerySelect = (options as any)?.select || 'entities'
    const res = useStoreQueryInternal(store, options)
    return (select === 'ids' ? (res.ids as Array<T['id']>) : res.data) as any
}
