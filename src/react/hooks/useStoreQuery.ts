import { useAtomValue } from 'jotai'
import { useMemo } from 'react'
import { Core } from '#core'
import type { Entity, FindManyOptions, StoreKey, StoreHandleOwner } from '#core'

type UseStoreQuerySelect = 'entities' | 'ids'

type UseStoreQueryOptions<T extends Entity> =
    & Pick<FindManyOptions<T>, 'where' | 'orderBy' | 'limit' | 'offset'>
    & { select?: UseStoreQuerySelect }

type StoreQueryResult<T extends Entity> = {
    ids: StoreKey[]
    data: T[]
}

function useStoreQueryInternal<T extends Entity, Relations = {}>(
    store: StoreHandleOwner<T, Relations>,
    options?: UseStoreQueryOptions<T>
): StoreQueryResult<T> {
    const handle = Core.store.getHandle(store)
    if (!handle) {
        throw new Error('[Atoma] useStoreQuery: 未找到 storeHandle（atom/jotaiStore），请确认 store 已通过 createStore 创建')
    }

    const map = useAtomValue(handle.atom, { store: handle.jotaiStore })
    const queryKey = useMemo(() => Core.query.stableStringify(options), [options])

    return useMemo(() => {
        const indexes = handle.indexes
        const candidate = indexes?.collectCandidates(options?.where as any)

        if (candidate?.kind === 'empty') return { ids: [], data: [] }

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
            : (Core.query.applyQuery(source, effectiveOptions as any, handle.matcher ? { matcher: handle.matcher } : undefined) as T[])

        return { ids: result.map(item => item.id), data: result }
    }, [map, handle.indexes, handle.matcher, queryKey])
}

export function useStoreQuery<T extends Entity, Relations = {}>(
    store: StoreHandleOwner<T, Relations>,
    options: UseStoreQueryOptions<T> & { select: 'ids' }
): Array<T['id']>

export function useStoreQuery<T extends Entity, Relations = {}>(
    store: StoreHandleOwner<T, Relations>,
    options?: UseStoreQueryOptions<T>
): T[] {
    const select: UseStoreQuerySelect = (options as any)?.select || 'entities'
    const res = useStoreQueryInternal(store, options)
    return (select === 'ids' ? (res.ids as Array<T['id']>) : res.data) as any
}
