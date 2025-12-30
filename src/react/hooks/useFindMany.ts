import { useAtomValue } from 'jotai'
import { useEffect, useMemo, useState } from 'react'
import { Core } from '#core'
import type { FindManyOptions, FetchPolicy, IStore, PageInfo, StoreKey, RelationIncludeInput, Entity, WithRelations } from '#core'
import { useRelations } from './useRelations'

type UseFindManySelect = 'entities' | 'ids'

type FindManyRemoteState<T extends Entity> = {
    data: T[]
    loading: boolean
    error?: Error
    isStale: boolean
    pageInfo?: PageInfo
}

const stripRuntimeOptions = (options?: any) => {
    if (!options) return undefined
    const { fetchPolicy: _fetchPolicy, select: _select, ...rest } = options
    return rest
}

const pickByFetchPolicy = <T,>(fetchPolicy: FetchPolicy, local: T[], remote: T[]) => {
    if (fetchPolicy === 'local') return local
    if (fetchPolicy === 'remote') return remote
    return local.length ? local : remote
}

type UseFindManyEntitiesResult<
    T extends Entity,
    Relations = {},
    Include extends RelationIncludeInput<Relations> = {}
> = {
    data: keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]
    loading: boolean
    error?: Error
    refetch: () => Promise<T[]>
    isStale: boolean
    pageInfo?: PageInfo
    fetchMore: (options: FindManyOptions<T>) => Promise<T[]>
}

type UseFindManyIdsResult<T extends Entity> = {
    data: Array<T['id']>
    loading: boolean
    error?: Error
    refetch: () => Promise<Array<T['id']>>
    isStale: boolean
    pageInfo?: PageInfo
    fetchMore: (options: FindManyOptions<T>) => Promise<Array<T['id']>>
}

export function useFindMany<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: IStore<T, Relations>,
    options?: FindManyOptions<T, RelationIncludeInput<Relations> & Include> & { fetchPolicy?: FetchPolicy; select?: 'entities' }
): UseFindManyEntitiesResult<T, Relations, Include>

export function useFindMany<T extends Entity, Relations = {}>(
    store: IStore<T, Relations>,
    options: Omit<FindManyOptions<T, any>, 'include'> & { include?: never; fetchPolicy?: FetchPolicy; select: 'ids' }
): UseFindManyIdsResult<T>

export function useFindMany<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: IStore<T, Relations>,
    options?: (FindManyOptions<T, RelationIncludeInput<Relations> & Include> & { fetchPolicy?: FetchPolicy; select?: UseFindManySelect })
): UseFindManyEntitiesResult<T, Relations, Include> | UseFindManyIdsResult<T> {
    const handle = Core.store.getHandle(store)
    if (!handle) {
        throw new Error('[Atoma] useFindMany: 未找到 storeHandle（atom/jotaiStore），请确认 store 已通过 createCoreStore/createStore 创建')
    }

    const objectMapAtom = handle.atom
    const jotaiStore = handle.jotaiStore

    const map = useAtomValue(objectMapAtom, { store: jotaiStore })
    const fetchPolicy: FetchPolicy = options?.fetchPolicy || 'local-then-remote'
    const shouldUseLocal = fetchPolicy !== 'remote'
    const baseFields = (options as any)?.fields
    const effectiveSkipStore = Boolean(options?.skipStore || baseFields?.length)
    const select: UseFindManySelect = (options as any)?.select || 'entities'

    const queryKey = useMemo(() => Core.query.stableStringify({ ...(options || {}), fetchPolicy }), [options, fetchPolicy])
    const optionsForFindMany = useMemo(() => stripRuntimeOptions(options), [queryKey])

    type RemoteState = FindManyRemoteState<T>
    const [remote, setRemote] = useState<RemoteState>(() => ({
        data: [],
        pageInfo: undefined,
        loading: fetchPolicy !== 'local',
        error: undefined,
        isStale: false
    }))

    const patchRemote = (patch: Partial<RemoteState>) => setRemote(prev => ({ ...prev, ...patch }))
    const resetRemote = (loading: boolean) => setRemote({ data: [], pageInfo: undefined, loading, error: undefined, isStale: false })

    // 本地过滤（仅在 local / local-then-remote 使用）
    const filteredIds = useMemo(() => {
        if (!shouldUseLocal) return []
        const indexes = handle.indexes
        const candidate = indexes?.collectCandidates(options?.where as any)

        if (candidate?.kind === 'empty') return []

        const source =
            candidate?.kind === 'candidates'
                ? Array.from(candidate.ids).map(id => map.get(id)).filter(Boolean) as T[]
                : Array.from(map.values())

        const shouldSkipWhere =
            candidate?.kind === 'candidates'
            && candidate.exactness === 'exact'
            && options?.where
            && typeof options.where === 'object'
            && typeof options.where !== 'function'

        const effectiveOptions = shouldSkipWhere
            ? ({ ...(options as any), where: undefined } as any)
            : options

        const shouldSkipApplyQuery =
            effectiveOptions
            && !effectiveOptions.where
            && !effectiveOptions.orderBy
            && effectiveOptions.limit === undefined
            && effectiveOptions.offset === undefined

        const result: T[] = shouldSkipApplyQuery
            ? source
            : (Core.query.applyQuery(source, effectiveOptions, handle.matcher ? { matcher: handle.matcher } : undefined) as T[])
        return result.map((item: T) => item.id)
    }, [shouldUseLocal, queryKey, map, handle.matcher, handle.indexes])

    const localData = useMemo(() => {
        if (!shouldUseLocal) return [] as T[]
        return filteredIds
            .map((id: StoreKey) => map.get(id))
            .filter((v): v is T => Boolean(v))
    }, [filteredIds, map, shouldUseLocal])

    const hasLocalSnapshot = (select === 'ids' ? filteredIds.length > 0 : localData.length > 0)
    const staleInLocalThenRemote = (fetchPolicy === 'local-then-remote' && hasLocalSnapshot)

    const upsertIntoMap = (items: T[]) => {
        if (!items.length) return
        jotaiStore.set(objectMapAtom, (prev: Map<StoreKey, T>) => {
            const next = new Map(prev)
            items.forEach(item => {
                next.set(item.id, item)
            })
            return next
        })
    }

    const normalizeResult = (res: any): { data: T[]; pageInfo?: PageInfo } => {
        if (res && Array.isArray(res.data)) return { data: res.data, pageInfo: res.pageInfo }
        return { data: [] }
    }

    useEffect(() => {
        if (fetchPolicy === 'local') {
            resetRemote(false)
            return
        }

        let cancelled = false
        resetRemote(true)

        const run = async () => {
            if (!store.findMany) {
                const err = new Error('findMany not implemented')
                patchRemote({ error: err, loading: false, isStale: staleInLocalThenRemote })
                return
            }
            try {
                const res = await store.findMany(optionsForFindMany as any)
                if (cancelled) return
                const { data, pageInfo } = normalizeResult(res)
                if (!effectiveSkipStore) {
                    upsertIntoMap(data)
                }
                patchRemote({ data, pageInfo, loading: false, isStale: staleInLocalThenRemote })
            } catch (err) {
                if (cancelled) return
                const e = err instanceof Error ? err : new Error(String(err))
                patchRemote({ loading: false, error: e, isStale: staleInLocalThenRemote })
            }
        }

        run()
        return () => { cancelled = true }
        // 说明：不依赖 localData，避免 local-then-remote 因本地缓存更新反复触发远程请求
    }, [queryKey, fetchPolicy, store])

    const refetch = () => {
        if (fetchPolicy === 'local') {
            return Promise.resolve(select === 'ids' ? (filteredIds as Array<T['id']>) : localData) as any
        }
        if (!store.findMany) {
            const err = new Error('findMany not implemented')
            patchRemote({ error: err, isStale: staleInLocalThenRemote, loading: false })
            return Promise.resolve(
                select === 'ids'
                    ? ((fetchPolicy === 'remote' ? remote.data : localData).map(i => i.id) as Array<T['id']>)
                    : (fetchPolicy === 'remote' ? remote.data : localData)
            ) as any
        }
        patchRemote({ isStale: false, loading: true })
        return store.findMany(optionsForFindMany as any)
            .then(res => {
                const { data, pageInfo } = normalizeResult(res)
                if (!effectiveSkipStore) {
                    upsertIntoMap(data)
                }
                patchRemote({ data, pageInfo, loading: false })
                return (select === 'ids' ? (data.map(i => i.id) as Array<T['id']>) : data) as any
            })
            .catch(err => {
                const e = err instanceof Error ? err : new Error(String(err))
                patchRemote({ loading: false, error: e, isStale: staleInLocalThenRemote })
                return (select === 'ids'
                    ? ((fetchPolicy === 'remote' ? remote.data : localData).map(i => i.id) as Array<T['id']>)
                    : (fetchPolicy === 'remote' ? remote.data : localData)) as any
            })
    }

    const fetchMore = async (moreOptions: FindManyOptions<T>): Promise<any> => {
        patchRemote({ loading: true })
        if (!store.findMany) {
            const err = new Error('findMany not implemented on store')
            patchRemote({ error: err, loading: false })
            throw err
        }
        try {
            const effectiveOptions: any = {
                ...moreOptions,
                fields: (moreOptions as any)?.fields ?? baseFields,
                // fields 存在时，强制 transient（不写入 store）
                skipStore: Boolean((moreOptions as any)?.skipStore || (moreOptions as any)?.fields?.length || baseFields?.length)
            }

            const res = await store.findMany(effectiveOptions)
            const { data, pageInfo: newPageInfo } = normalizeResult(res)

            if (effectiveSkipStore) {
                setRemote(prev => ({
                    ...prev,
                    data: [...prev.data, ...data],
                    pageInfo: newPageInfo,
                    loading: false
                }))
            } else {
                upsertIntoMap(data)
                patchRemote({ pageInfo: newPageInfo, loading: false })
            }
            return select === 'ids' ? (data.map(i => i.id) as Array<T['id']>) : data
        } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err))
            patchRemote({ loading: false, error: e })
            throw e
        }
    }

    // local-then-remote 场景下，优先返回最新的本地缓存（可被 add/update 等立即更新）
    // remote.data 只在本地为空时兜底，避免远程快照阻塞本地实时更新
    if (select === 'ids') {
        const localIds = filteredIds as Array<T['id']>
        const remoteIds = remote.data.map(item => item.id) as Array<T['id']>
        const data = pickByFetchPolicy(fetchPolicy, localIds, remoteIds)

        return {
            data,
            loading: remote.loading,
            error: remote.error,
            refetch,
            isStale: remote.isStale,
            pageInfo: remote.pageInfo,
            fetchMore
        } satisfies UseFindManyIdsResult<T>
    }

    const data = pickByFetchPolicy(fetchPolicy, localData, remote.data)

    const relations = handle.relations?.() as Relations | undefined
    const resolveStore = handle.services.resolveStore
    const effectiveInclude = (options as any)?.include ?? ({} as Include)
    const relationsResult = useRelations<T, Relations, Include>(data, effectiveInclude, relations, resolveStore)
    const finalData = relationsResult.data
    const combinedError = relationsResult.error ?? remote.error

    return {
        data: finalData as unknown as (keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]),
        loading: remote.loading || relationsResult.loading,
        error: combinedError,
        refetch,
        isStale: remote.isStale,
        pageInfo: remote.pageInfo,
        fetchMore
    } satisfies UseFindManyEntitiesResult<T, Relations, Include>
}
