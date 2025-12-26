import { useAtomValue } from 'jotai'
import { useEffect, useMemo, useState } from 'react'
import { Core } from '#core'
import type { FindManyOptions, FetchPolicy, IStore, PageInfo, StoreKey, RelationIncludeInput, Entity } from '#core'
import type { UseFindManyResult } from '../types'
import { useRelations } from './useRelations'

export function useFindMany<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: IStore<T, Relations>,
    options?: FindManyOptions<T, Include> & { fetchPolicy?: FetchPolicy }
): UseFindManyResult<T, Relations, Include> {
    const handle = Core.store.getHandle(store)
    if (!handle) {
        throw new Error('[Atoma] useFindMany: 未找到 storeHandle（atom/jotaiStore），请确认 store 已通过 createCoreStore/createStore 创建')
    }

    const objectMapAtom = handle.atom
    const jotaiStore = handle.jotaiStore

    const map = useAtomValue(objectMapAtom, { store: jotaiStore })
    const fetchPolicy: FetchPolicy = options?.fetchPolicy || 'local-then-remote'
    const shouldUseLocal = fetchPolicy !== 'remote'
    const effectiveSkipStore = Boolean(options?.skipStore || (options as any)?.fields?.length)

    const queryKey = useMemo(() => Core.query.stableStringify({ ...(options || {}), fetchPolicy }), [options, fetchPolicy])
    const fields = useMemo(() => shouldUseLocal ? Core.query.extractQueryFields(options) : [], [shouldUseLocal, queryKey])
    const fieldsKey = useMemo(() => shouldUseLocal ? versionKey(fields) : '', [fields, shouldUseLocal])

    // Only track version when本地过滤
    const relevantVersion = useMemo(
        () => {
            if (!shouldUseLocal) return 0
            return handle.services.mutation.versions.getSnapshot(objectMapAtom, fields)
        },
        [objectMapAtom, fieldsKey, shouldUseLocal, handle]
    )

    const [remoteData, setRemoteData] = useState<T[]>([])
    const [pageInfo, setPageInfo] = useState<PageInfo | undefined>(undefined)
    const [loading, setLoading] = useState(fetchPolicy !== 'local')
    const [error, setError] = useState<Error | undefined>(undefined)
    const [isStale, setIsStale] = useState(false)

    // 本地过滤（仅在 local / local-then-remote 使用）
    const filteredIds = useMemo(() => {
        if (!shouldUseLocal) return []
        const arr = Array.from(map.values())
        const result = Core.query.applyQuery(arr, options, handle.matcher ? { matcher: handle.matcher } : undefined)
        return result.map(item => item.id)
    }, [shouldUseLocal, relevantVersion, queryKey, map, handle.matcher])

    const localData = useMemo(() => {
        if (!shouldUseLocal) return [] as T[]
        return filteredIds
            .map(id => map.get(id))
            .filter(Boolean) as T[]
    }, [filteredIds, map, shouldUseLocal])

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
            setLoading(false)
            setRemoteData([])
            setPageInfo(undefined)
            setError(undefined)
            setIsStale(false)
            return
        }

        let cancelled = false
        setLoading(true)
        setError(undefined)
        setIsStale(false)
        setRemoteData([])
        setPageInfo(undefined)

        const run = async () => {
            if (!store.findMany) {
                const err = new Error('findMany not implemented')
                setError(err)
                setLoading(false)
                setIsStale(fetchPolicy === 'local-then-remote' && localData.length > 0)
                return
            }
            try {
                const res = await store.findMany(options)
                if (cancelled) return
                const { data, pageInfo } = normalizeResult(res)
                if (!effectiveSkipStore) {
                    upsertIntoMap(data)
                }
                setRemoteData(data)
                setPageInfo(pageInfo)
                setLoading(false)
                setIsStale(fetchPolicy === 'local-then-remote' && localData.length > 0)
            } catch (err) {
                if (cancelled) return
                const e = err instanceof Error ? err : new Error(String(err))
                setLoading(false)
                setError(e)
                setIsStale(fetchPolicy === 'local-then-remote' && localData.length > 0)
            }
        }

        run()
        return () => { cancelled = true }
        // 说明：不依赖 localData，避免 local-then-remote 因本地缓存更新反复触发远程请求
    }, [queryKey, fetchPolicy, store])

    const refetch = () => {
        if (fetchPolicy === 'local') return Promise.resolve(localData)
        if (!store.findMany) {
            const err = new Error('findMany not implemented')
            setError(err)
            setIsStale(fetchPolicy === 'local-then-remote' && localData.length > 0)
            setLoading(false)
            return Promise.resolve(fetchPolicy === 'remote' ? remoteData : localData)
        }
        setIsStale(false)
        setLoading(true)
        return store.findMany(options)
            .then(res => {
                const { data, pageInfo } = normalizeResult(res)
                if (!effectiveSkipStore) {
                    upsertIntoMap(data)
                }
                setRemoteData(data)
                setPageInfo(pageInfo)
                setLoading(false)
                return data
            })
            .catch(err => {
                const e = err instanceof Error ? err : new Error(String(err))
                setLoading(false)
                setError(e)
                setIsStale(fetchPolicy === 'local-then-remote' && localData.length > 0)
                return fetchPolicy === 'remote' ? remoteData : localData
            })
    }

    const fetchMore = async (moreOptions: FindManyOptions<T>): Promise<T[]> => {
        setLoading(true)
        if (!store.findMany) {
            const err = new Error('findMany not implemented on store')
            setError(err)
            setLoading(false)
            throw err
        }
        try {
            const baseFields = (options as any)?.fields
            const effectiveOptions: any = {
                ...moreOptions,
                fields: (moreOptions as any)?.fields ?? baseFields,
                // fields 存在时，强制 transient（不写入 store）
                skipStore: Boolean((moreOptions as any)?.skipStore || (moreOptions as any)?.fields?.length || baseFields?.length)
            }

            const res = await store.findMany(effectiveOptions)
            const { data, pageInfo: newPageInfo } = normalizeResult(res)

            if (effectiveSkipStore) {
                setRemoteData(prev => [...prev, ...data])
            } else {
                upsertIntoMap(data)
            }

            setPageInfo(newPageInfo)
            setLoading(false)
            return data
        } catch (err) {
            const e = err instanceof Error ? err : new Error(String(err))
            setLoading(false)
            setError(e)
            throw e
        }
    }

    // local-then-remote 场景下，优先返回最新的本地缓存（可被 add/update 等立即更新）
    // remoteData 只在本地为空时兜底，避免远程快照阻塞本地实时更新
    const data =
        fetchPolicy === 'local'
            ? localData
            : fetchPolicy === 'remote'
                ? remoteData
                : (localData.length ? localData : remoteData)

    const relations = handle.relations?.()
    const resolveStore = handle.services.resolveStore
    const relationsResult = useRelations(data, options?.include as any, relations, resolveStore)
    const finalData = relationsResult.data
    const combinedError = relationsResult.error ?? error

    return {
        data: finalData as any,
        loading: loading || relationsResult.loading,
        error: combinedError,
        refetch,
        isStale,
        pageInfo,
        fetchMore
    }
}

// simple deterministic key for fields array
const versionKey = (fields: string[]) => fields.slice().sort().join('|')
