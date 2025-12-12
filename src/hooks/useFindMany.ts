import { PrimitiveAtom, createStore } from 'jotai'
import { useAtomValue } from 'jotai'
import { useEffect, useMemo, useState, useRef } from 'react'
import { applyQuery, extractQueryFields, stableStringify } from '../core/query'
import { getVersionSnapshot, globalStore } from '../core/BaseStore'
import { FindManyOptions, FetchPolicy, IStore, PageInfo, StoreKey, UseFindManyResult, RelationMap, Entity } from '../core/types'
import { RelationResolver } from '../core/relations/RelationResolver'

export function createUseFindMany<T extends Entity, Relations extends RelationMap<T> = {}>(
    objectMapAtom: PrimitiveAtom<Map<StoreKey, T>>,
    store: IStore<T, Relations>,
    jotaiStore?: ReturnType<typeof createStore>
) {
    const actualStore = jotaiStore || globalStore

    return function useFindMany<Include extends Partial<Record<keyof Relations, any>> = {}>(options?: FindManyOptions<T, Include> & { fetchPolicy?: FetchPolicy }): UseFindManyResult<T, Relations, Include> {
        const map = useAtomValue(objectMapAtom, { store: actualStore })
        const fetchPolicy: FetchPolicy = options?.fetchPolicy || 'local-then-remote'
        const shouldUseLocal = fetchPolicy !== 'remote'

        const queryKey = useMemo(() => stableStringify({ ...(options || {}), fetchPolicy }), [options, fetchPolicy])
        const fields = useMemo(() => shouldUseLocal ? extractQueryFields(options) : [], [shouldUseLocal, queryKey])
        const fieldsKey = useMemo(() => shouldUseLocal ? versionKey(fields) : '', [fields, shouldUseLocal])

        // Only track version when本地过滤
        const relevantVersion = useMemo(
            () => shouldUseLocal ? getVersionSnapshot(objectMapAtom, fields) : 0,
            [objectMapAtom, fieldsKey, shouldUseLocal]
        )

        const [remoteData, setRemoteData] = useState<T[]>([])
        const [pageInfo, setPageInfo] = useState<PageInfo | undefined>(undefined)
        const [loading, setLoading] = useState(fetchPolicy !== 'local')
        const [error, setError] = useState<Error | undefined>(undefined)
        const [isStale, setIsStale] = useState(false)
        const [finalData, setFinalData] = useState<T[]>([])
        const [relationLoading, setRelationLoading] = useState(false)

        // 本地过滤（仅在 local / local-then-remote 使用）
        const filteredIds = useMemo(() => {
            if (!shouldUseLocal) return []
            const arr = Array.from(map.values()) as T[]
            const result = applyQuery(arr as any, options) as T[]
            return result.map(item => (item as any).id as StoreKey)
        }, [shouldUseLocal, relevantVersion, queryKey, map])

        const localData = useMemo(() => {
            if (!shouldUseLocal) return [] as T[]
            return filteredIds
                .map(id => map.get(id))
                .filter(Boolean) as T[]
        }, [filteredIds, map, shouldUseLocal])

        const upsertIntoMap = (items: T[]) => {
            if (!items.length) return
            actualStore.set(objectMapAtom, prev => {
                const next = new Map(prev)
                items.forEach(item => {
                    const id = (item as any)?.id
                    if (id !== undefined) {
                        next.set(id, item)
                    }
                })
                return next
            })
        }

        const normalizeResult = (res: any): { data: T[]; pageInfo?: PageInfo } => {
            if (Array.isArray(res)) return { data: res }
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
                    if (!options?.skipStore) {
                        upsertIntoMap(data)
                    }
                    setRemoteData(data)
                    setPageInfo(pageInfo)
                    setLoading(false)
                } catch (err: any) {
                    if (cancelled) return
                    const e = err instanceof Error ? err : new Error(String(err))
                    setError(e)
                    setLoading(false)
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
                    if (!options?.skipStore) {
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
            // For transient queries, we must merge locally
            // For store queries, the store handles merging, but we should make sure we return the merged result or just the new chunks.
            // Usually fetchMore returns the *new* data.
            setLoading(true)
            if (!store.findMany) {
                const err = new Error('findMany not implemented on store')
                setError(err)
                setLoading(false)
                throw err
            }
            try {
                // Use skipStore setting from original options if not overridden (or force it to match?)
                // Generally we want consistency.
                const effectiveOptions = { ...moreOptions, skipStore: options?.skipStore }

                const res = await store.findMany(effectiveOptions)
                const { data, pageInfo: newPageInfo } = normalizeResult(res)

                if (options?.skipStore) {
                    setRemoteData(prev => [...prev, ...data])
                } else {
                    upsertIntoMap(data)
                    // In store mode, we don't manually append to remoteData usually because useFindMany recalculates `data` based on options.
                    // BUT, `localData` is derived from `options.limit`.
                    // If the user calls `fetchMore` but hasn't updated `limit` prop yet, they won't see it in `localData`.
                    // This is expected behavior for "explicit control".
                    // However, we might want to return the new data so they can check it.
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

        useEffect(() => {
            // 无 include 或无关系定义时直接返回数据
            if (!options?.include || !store._relations || data.length === 0) {
                setFinalData(data)
                setRelationLoading(false)
                return
            }

            let cancelled = false
            setRelationLoading(true)

            // 默认 skipStore: true 避免污染缓存
            const includeWithSkipStore = Object.fromEntries(
                Object.entries(options.include).map(([key, opts]) => {
                    if (opts === false || opts === undefined) return [key, opts]
                    if (opts && typeof opts === 'object') {
                        const o = opts as any
                        return [key, { ...o, skipStore: o.skipStore ?? true }]
                    }
                    return [key, { skipStore: true }]
                })
            ) as Record<string, boolean | FindManyOptions<any>>

            RelationResolver.resolveBatch(
                data,
                includeWithSkipStore,
                store._relations as any,
                { onError: 'partial', timeout: 5000, maxConcurrency: 10 }
            )
                .then(resolved => {
                    if (cancelled) return
                    setFinalData(resolved)
                })
                .catch(err => {
                    console.error('[Atoma Relations] Resolution failed:', err)
                    if (!cancelled) {
                        setFinalData(data)
                    }
                })
                .finally(() => {
                    if (!cancelled) setRelationLoading(false)
                })

            return () => { cancelled = true }
        // stableStringify 用于 include 依赖
        }, [data, stableStringify(options?.include), store._relations])

        return {
            data: finalData as any,
            loading: loading || relationLoading,
            error,
            refetch,
            isStale,
            pageInfo,
            fetchMore
        }
    }
}

// simple deterministic key for fields array
const versionKey = (fields: string[]) => fields.slice().sort().join('|')
