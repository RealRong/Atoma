import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Relations } from 'atoma-core'
import { stableStringify } from 'atoma-shared'
import type { Entity, IStore, RelationIncludeInput, StoreToken, WithRelations } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { STORE_BINDINGS, getStoreBindings } from 'atoma-types/internal'
import { useShallowStableArray } from './useShallowStableArray'
import { createBatchedSubscribe } from './internal/batchedSubscribe'

const DEFAULT_PREFETCH_OPTIONS = { onError: 'partial', timeout: 5000, maxConcurrency: 10 } as const
const PREFETCH_DEDUP_TTL_MS = 300

type PrefetchEntry = {
    promise: Promise<unknown>
    doneAt: number
}

export interface UseRelationsResult<T extends Entity> {
    data: T[]
    loading: boolean
    error?: Error
    refetch: () => Promise<T[]>
}

export function useRelations<T extends Entity, Relations>(
    items: T[],
    include: undefined,
    relations: Relations | undefined,
    resolveStore?: (name: StoreToken) => IStore<any, any> | undefined
): UseRelationsResult<T>

export function useRelations<T extends Entity, Relations, const Include extends RelationIncludeInput<Relations>>(
    items: T[],
    include: Include,
    relations: Relations | undefined,
    resolveStore?: (name: StoreToken) => IStore<any, any> | undefined
): UseRelationsResult<keyof Include extends never ? T : WithRelations<T, Relations, Include>>

export function useRelations<T extends Entity>(
    items: T[],
    include: Record<string, any> | undefined,
    relations: any | undefined,
    resolveStore?: (name: StoreToken) => IStore<any, any> | undefined
): UseRelationsResult<any> {
    const resolveStoreRef = useRef(resolveStore)
    useEffect(() => {
        resolveStoreRef.current = resolveStore
    }, [resolveStore])

    const prefetchCacheRef = useRef<Map<string, PrefetchEntry>>(new Map())
    const wrappedStoreCacheRef = useRef<WeakMap<object, any>>(new WeakMap())
    const prevIdsRef = useRef<Set<EntityId>>(new Set())
    const prefetchDoneRef = useRef<Set<string>>(new Set())

    const dedupePrefetch = useCallback(<T,>(key: string, task: () => Promise<T>): Promise<T> => {
        const now = Date.now()
        const existing = prefetchCacheRef.current.get(key)
        if (existing) {
            if (existing.doneAt === 0) return existing.promise as Promise<T>
            if (now - existing.doneAt < PREFETCH_DEDUP_TTL_MS) return existing.promise as Promise<T>
        }

        const promise = Promise.resolve().then(task)
        const entry: PrefetchEntry = { promise, doneAt: 0 }
        prefetchCacheRef.current.set(key, entry)

        promise
            .then(() => {
                entry.doneAt = Date.now()
            })
            .catch(() => {
                prefetchCacheRef.current.delete(key)
            })

        return promise
    }, [])

    const resolveStoreStable = useCallback((name: StoreToken) => {
        const store = resolveStoreRef.current?.(name)
        if (!store) return store

        const cached = wrappedStoreCacheRef.current.get(store as any)
        if (cached) return cached

        const storeName = String((store as any)?.name ?? name ?? '')
        const query = typeof store.query === 'function' ? store.query.bind(store) : undefined
        const getMany = typeof store.getMany === 'function' ? store.getMany.bind(store) : undefined

        const wrapped = {
            ...store,
            query: query
                ? (q: any) => {
                    const key = `rel:query:${storeName}:${stableStringify(q)}`
                    return dedupePrefetch(key, () => Promise.resolve(query(q)))
                }
                : query,
            getMany: getMany
                ? (ids: any[], cache?: any, options?: any) => {
                    const normalizedIds = Array.isArray(ids) ? [...new Set(ids.map(String))].sort() : []
                    const key = `rel:getMany:${storeName}:${stableStringify(normalizedIds)}:${cache ? '1' : '0'}:${stableStringify(options)}`
                    return dedupePrefetch(key, () => Promise.resolve(getMany(ids, cache, options)))
                }
                : getMany
        }
        const bindings = (store as any)?.[STORE_BINDINGS]
        if (bindings) {
            Object.defineProperty(wrapped, STORE_BINDINGS, {
                value: bindings,
                enumerable: false,
                configurable: false
            })
        }

        wrappedStoreCacheRef.current.set(store as any, wrapped)
        return wrapped
    }, [])

    const effectiveInclude = include && typeof include === 'object' && Object.keys(include).length === 0
        ? undefined
        : include

    const includeKey = useMemo(() => stableStringify(effectiveInclude), [effectiveInclude])
    const stableItems = useShallowStableArray(items)

    type State = { data: T[]; loading: boolean; error?: Error }
    const [state, setState] = useState<State>(() => ({ data: stableItems, loading: false, error: undefined }))
    const patchState = (patch: Partial<State>) => setState(prev => ({ ...prev, ...patch }))

    const snapshotRef = useRef<Map<EntityId, Record<string, any>>>(new Map())
    const snapshotNamesRef = useRef<string[]>([])
    const clearSnapshot = () => {
        snapshotRef.current = new Map()
        snapshotNamesRef.current = []
    }

    const { liveInclude, snapshotInclude, snapshotNames } = useMemo(() => {
        if (!effectiveInclude) return { liveInclude: undefined, snapshotInclude: undefined, snapshotNames: [] as string[] }

        const live: Record<string, any> = {}
        const snapshot: Record<string, any> = {}
        Object.entries(effectiveInclude).forEach(([name, opts]) => {
            if (opts === false || opts === undefined || opts === null) return
            const isLive = typeof opts === 'object' ? (opts as any).live !== false : true
            ;(isLive ? live : snapshot)[name] = opts
        })

        const snapshotNames = Object.keys(snapshot)
        return {
            liveInclude: Object.keys(live).length ? live : undefined,
            snapshotInclude: snapshotNames.length ? snapshot : undefined,
            snapshotNames
        }
    }, [includeKey])

    // include/relations 变化时先清空快照，避免短暂合并旧数据
    useEffect(() => {
        clearSnapshot()
    }, [includeKey, relations])

    useEffect(() => {
        prefetchDoneRef.current = new Set()
    }, [includeKey, relations])

    const getEntityId = (item: any): EntityId | undefined => {
        const id = item?.id
        return (typeof id === 'string' && id) ? (id as EntityId) : undefined
    }

    const getPrefetchMode = (relConfig: any, includeValue: any): 'on-mount' | 'on-change' | 'manual' => {
        if (includeValue && typeof includeValue === 'object') {
            const mode = includeValue.prefetch
            if (mode === 'on-mount' || mode === 'on-change' || mode === 'manual') return mode
        }
        return relConfig?.type === 'hasMany' ? 'on-mount' : 'on-change'
    }

    const getStoreMap = (storeToken: StoreToken) => {
        if (!resolveStoreRef.current) return undefined
        const store = resolveStoreStable(storeToken)
        if (!store) return undefined
        const bindings = getStoreBindings(store as any, 'useRelations')
        return {
            map: bindings.source.getSnapshot() as Map<EntityId, any>,
            indexes: bindings.indexes
        }
    }

    const project = (source: T[]): T[] => {
        if (!effectiveInclude || !relations || !resolveStoreRef.current || source.length === 0) return source

        const projectedLive = Relations.projectRelationsBatch(
            source,
            liveInclude,
            relations,
            getStoreMap
        ) as T[]

        const names = snapshotNamesRef.current
        if (!names.length) return projectedLive

        const snapshot = snapshotRef.current
        return projectedLive.map(item => {
            const cached = snapshot.get((item as any).id as EntityId)
            if (!cached) return item
            return { ...item, ...cached } as any
        })
    }

    const buildSnapshot = (source: T[]) => {
        clearSnapshot()
        if (!snapshotInclude || !snapshotNames.length || !relations || !resolveStoreRef.current || source.length === 0) return

        const projected = Relations.projectRelationsBatch(source, snapshotInclude, relations, getStoreMap) as any[]

        const next = new Map<EntityId, Record<string, any>>()
        projected.forEach(item => {
            const id = (item as any)?.id
            if (!(typeof id === 'string' && id)) return
            const values: Record<string, any> = {}
            snapshotNames.forEach(name => { values[name] = item[name] })
            next.set(id as EntityId, values)
        })

        snapshotRef.current = next
        snapshotNamesRef.current = snapshotNames
    }

    const prefetchAndProject = async (options?: { cancelled?: () => boolean; force?: boolean }): Promise<T[]> => {
        const currentIds = new Set<EntityId>()
        stableItems.forEach(item => {
            const id = getEntityId(item)
            if (id) currentIds.add(id)
        })

        const previousIds = prevIdsRef.current
        const newIds = new Set<EntityId>()
        currentIds.forEach(id => {
            if (!previousIds.has(id)) newIds.add(id)
        })

        if (!effectiveInclude || !relations || stableItems.length === 0) {
            clearSnapshot()
            setState({ data: stableItems, loading: false, error: undefined })
            prevIdsRef.current = currentIds
            return stableItems
        }

        if (!resolveStoreRef.current) {
            const err = new Error('[Atoma] useRelations: 缺少 resolveStore（StoreToken -> IStore），无法解析 include 关系')
            setState({ data: stableItems, loading: false, error: err })
            prevIdsRef.current = currentIds
            return stableItems
        }

        patchState({ loading: true, error: undefined })
        try {
            const entries = (effectiveInclude && typeof effectiveInclude === 'object')
                ? Object.entries(effectiveInclude)
                : []

            const tasks: Array<Promise<void>> = []
            const markDone: string[] = []

            entries.forEach(([name, value]) => {
                if (value === false || value === undefined || value === null) return

                const relConfig = (relations as any)?.[name]
                if (!relConfig) return

                const mode = getPrefetchMode(relConfig, value)
                if (!options?.force && mode === 'manual') return

                const doneKey = `${includeKey}:${name}`
                const shouldPrefetch = options?.force
                    || mode === 'on-change'
                    || (!prefetchDoneRef.current.has(doneKey) && stableItems.length > 0)

                if (!shouldPrefetch) return

                let itemsForRelation = stableItems
                if (!options?.force && relConfig.type === 'hasMany' && newIds.size) {
                    itemsForRelation = stableItems.filter(item => {
                        const id = getEntityId(item)
                        return id && !newIds.has(id)
                    })
                }

                if (!itemsForRelation.length) {
                    if (mode === 'on-mount' && stableItems.length > 0) markDone.push(doneKey)
                    return
                }

                const includeArg = { [name]: value } as Record<string, any>
                tasks.push(Relations.RelationResolver.prefetchBatch(
                    itemsForRelation,
                    includeArg,
                    relations,
                    resolveStoreStable,
                    DEFAULT_PREFETCH_OPTIONS
                ))

                if (mode === 'on-mount') markDone.push(doneKey)
            })

            await Promise.all(tasks)
            markDone.forEach(key => prefetchDoneRef.current.add(key))
        } catch (err: any) {
            const e = err instanceof Error ? err : new Error(String(err))
            patchState({ error: e })
        } finally {
            if (!options?.cancelled?.()) patchState({ loading: false })
            prevIdsRef.current = currentIds
        }

        if (options?.cancelled?.()) return stableItems

        buildSnapshot(stableItems)
        const projected = project(stableItems)
        patchState({ data: projected })
        return projected
    }

    // items/include/relations 变化：触发 prefetch（并刷新 snapshot）
    useEffect(() => {
        let cancelled = false

        const run = async () => {
            await prefetchAndProject({ cancelled: () => cancelled })
        }

        run()
        return () => { cancelled = true }
    }, [stableItems, includeKey, relations, resolveStoreStable])

    // live 订阅：监听相关 store map 变化
    const [liveTick, setLiveTick] = useState(0)
    useEffect(() => {
        if (!liveInclude || !relations || !resolveStoreRef.current) return

        const tokens = Relations.collectRelationStoreTokens(liveInclude, relations)
        if (!tokens.length) return

        const unsubscribers: Array<() => void> = []
        tokens.forEach(token => {
            const store = resolveStoreStable(token)
            if (!store) return
            const source = getStoreBindings(store as any, 'useRelations').source
            const subscribe = createBatchedSubscribe((listener: () => void) => source.subscribe(listener))
            const unsub = subscribe(() => setLiveTick(t => t + 1))
            unsubscribers.push(unsub)
        })

        return () => {
            unsubscribers.forEach(fn => fn())
        }
    }, [includeKey, relations, resolveStoreStable])

    // liveTick 变化：仅重算 live 投影，并合并 snapshot
    useEffect(() => {
        patchState({ data: project(stableItems) })
    }, [stableItems, includeKey, relations, resolveStoreStable, liveTick])

    const refetch = () => prefetchAndProject({ force: true })

    return { data: state.data, loading: state.loading, error: state.error, refetch }
}
