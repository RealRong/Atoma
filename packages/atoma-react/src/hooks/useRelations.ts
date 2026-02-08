import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stableStringify } from 'atoma-shared'
import type { Entity, IStore, RelationIncludeInput, StoreToken, WithRelations } from 'atoma-types/core'
import type { RuntimeEngine, RuntimeRelationInclude, RuntimeStoreMap } from 'atoma-types/runtime'
import type { EntityId } from 'atoma-types/protocol'
import { STORE_BINDINGS, getStoreBindings } from 'atoma-types/internal'
import { useShallowStableArray } from './useShallowStableArray'
import { createBatchedSubscribe } from './internal/batchedSubscribe'
import {
    buildPrefetchDoneKey,
    collectCurrentAndNewIds,
    filterStableItemsForRelation,
    getEntityId,
    normalizeInclude,
    normalizeStoreName,
    resolvePrefetchMode
} from './internal/relationInclude'

const DEFAULT_PREFETCH_OPTIONS = { onError: 'partial', timeout: 5000, maxConcurrency: 10 } as const
const PREFETCH_DEDUP_TTL_MS = 300

type PrefetchEntry = {
    promise: Promise<unknown>
    doneAt: number
}

type RelationConfigLike = {
    type?: unknown
    store?: unknown
    branches?: Array<{
        relation?: {
            store?: unknown
        }
    }>
}

function collectRelationTokensFromInclude(
    include: RuntimeRelationInclude,
    relations: Record<string, unknown> | undefined
): StoreToken[] {
    if (!include || !relations) return []

    const output = new Set<StoreToken>()
    Object.entries(include).forEach(([name, value]) => {
        if (value === false || value === undefined || value === null) return

        const relation = relations[name] as RelationConfigLike | undefined
        if (!relation || typeof relation !== 'object') return

        if (relation.type === 'variants') {
            relation.branches?.forEach(branch => {
                const store = branch.relation?.store
                if (typeof store === 'string' && store) output.add(store)
            })
            return
        }

        if (typeof relation.store === 'string' && relation.store) {
            output.add(relation.store)
        }
    })

    return Array.from(output)
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
    const engineRef = useRef<RuntimeEngine | undefined>(undefined)

    useEffect(() => {
        resolveStoreRef.current = resolveStore
    }, [resolveStore])

    const prefetchCacheRef = useRef<Map<string, PrefetchEntry>>(new Map())
    const wrappedStoreCacheRef = useRef<WeakMap<object, IStore<any, any>>>(new WeakMap())
    const prevIdsRef = useRef<Set<EntityId>>(new Set())
    const prefetchDoneRef = useRef<Set<string>>(new Set())

    const dedupePrefetch = useCallback(<TResult,>(key: string, task: () => Promise<TResult>): Promise<TResult> => {
        const now = Date.now()
        const existing = prefetchCacheRef.current.get(key)
        if (existing) {
            if (existing.doneAt === 0) return existing.promise as Promise<TResult>
            if (now - existing.doneAt < PREFETCH_DEDUP_TTL_MS) return existing.promise as Promise<TResult>
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

    const resolveStoreStable = useCallback((name: StoreToken): IStore<any, any> | undefined => {
        const store = resolveStoreRef.current?.(name)
        if (!store) return store

        const cached = wrappedStoreCacheRef.current.get(store as object)
        if (cached) return cached

        const storeName = normalizeStoreName(store, name)
        const query = typeof store.query === 'function' ? store.query.bind(store) : undefined
        const getMany = typeof store.getMany === 'function' ? store.getMany.bind(store) : undefined

        const wrapped: IStore<any, any> = {
            ...store,
            query: query
                ? (q: any) => {
                    const key = `rel:query:${storeName}:${stableStringify(q)}`
                    return dedupePrefetch(key, () => Promise.resolve(query(q)))
                }
                : query,
            getMany: getMany
                ? (ids: any[], cache?: boolean, options?: any) => {
                    const normalizedIds = Array.isArray(ids)
                        ? [...new Set(ids.map(String))].sort()
                        : []
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

        wrappedStoreCacheRef.current.set(store as object, wrapped)
        return wrapped
    }, [dedupePrefetch])

    const relationMap = relations as Record<string, unknown> | undefined

    const resolveEngine = useCallback((includeArg: RuntimeRelationInclude): RuntimeEngine | undefined => {
        if (engineRef.current) return engineRef.current
        if (!includeArg || !relationMap || !resolveStoreRef.current) return undefined

        const tokens = collectRelationTokensFromInclude(includeArg, relationMap)
        for (const token of tokens) {
            const store = resolveStoreStable(token)
            if (!store) continue
            const bindings = getStoreBindings(store as any, 'useRelations')
            if (!bindings.engine) continue
            engineRef.current = bindings.engine
            return bindings.engine
        }

        return undefined
    }, [relationMap, resolveStoreStable])

    const includePlan = useMemo(() => normalizeInclude(include), [include])
    const { includeKey, effectiveInclude, liveInclude, snapshotInclude, snapshotNames } = includePlan
    const stableItems = useShallowStableArray(items)

    type State = { data: T[]; loading: boolean; error?: Error }
    const [state, setState] = useState<State>(() => ({ data: stableItems, loading: false, error: undefined }))
    const patchState = (patch: Partial<State>) => setState(prev => ({ ...prev, ...patch }))

    const snapshotRef = useRef<Map<EntityId, Record<string, unknown>>>(new Map())
    const snapshotNamesRef = useRef<string[]>([])
    const clearSnapshot = () => {
        snapshotRef.current = new Map()
        snapshotNamesRef.current = []
    }

    useEffect(() => {
        clearSnapshot()
    }, [includeKey, relations])

    useEffect(() => {
        prefetchDoneRef.current = new Set()
    }, [includeKey, relations])

    const getStoreMap = (storeToken: StoreToken): RuntimeStoreMap | undefined => {
        if (!resolveStoreRef.current) return undefined

        const store = resolveStoreStable(storeToken)
        if (!store) return undefined

        const bindings = getStoreBindings(store as any, 'useRelations')
        if (!engineRef.current && bindings.engine) {
            engineRef.current = bindings.engine
        }

        return {
            map: bindings.source.getSnapshot() as Map<EntityId, Entity>,
            indexes: bindings.indexes
        }
    }

    const project = (source: T[]): T[] => {
        if (!effectiveInclude || !relations || !resolveStoreRef.current || source.length === 0) return source

        const engine = resolveEngine(liveInclude)
        if (!engine) return source

        const projectedLive = engine.projectRelationsBatch(
            source,
            liveInclude,
            relations as any,
            getStoreMap
        ) as T[]

        const names = snapshotNamesRef.current
        if (!names.length) return projectedLive

        const snapshot = snapshotRef.current
        return projectedLive.map(item => {
            const id = getEntityId(item as any)
            if (!id) return item
            const cached = snapshot.get(id)
            if (!cached) return item
            return { ...item, ...cached } as T
        })
    }

    const buildSnapshot = (source: T[]) => {
        clearSnapshot()
        if (!snapshotInclude || !snapshotNames.length || !relations || !resolveStoreRef.current || source.length === 0) return

        const engine = resolveEngine(snapshotInclude)
        if (!engine) return

        const projected = engine.projectRelationsBatch(
            source,
            snapshotInclude,
            relations as any,
            getStoreMap
        ) as Array<T & Record<string, unknown>>

        const next = new Map<EntityId, Record<string, unknown>>()
        projected.forEach(item => {
            const id = getEntityId(item)
            if (!id) return

            const values: Record<string, unknown> = {}
            snapshotNames.forEach(name => {
                values[name] = item[name]
            })
            next.set(id, values)
        })

        snapshotRef.current = next
        snapshotNamesRef.current = snapshotNames
    }

    const prefetchAndProject = async (options?: { cancelled?: () => boolean; force?: boolean }): Promise<T[]> => {
        const previousIds = prevIdsRef.current
        const { currentIds, newIds } = collectCurrentAndNewIds(stableItems, previousIds)

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

        const engine = resolveEngine(effectiveInclude)
        if (!engine) {
            const err = new Error('[Atoma] useRelations: store 缺少 RuntimeEngine 绑定，无法执行关系预取/投影')
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

                const relConfig = relationMap?.[name]
                if (!relConfig) return

                const mode = resolvePrefetchMode(relConfig, value)
                if (!options?.force && mode === 'manual') return

                const doneKey = buildPrefetchDoneKey({ includeKey, relationName: name })
                const shouldPrefetch = options?.force
                    || mode === 'on-change'
                    || (!prefetchDoneRef.current.has(doneKey) && stableItems.length > 0)

                if (!shouldPrefetch) return

                const itemsForRelation = filterStableItemsForRelation({
                    items: stableItems,
                    relationConfig: relConfig,
                    mode,
                    newIds,
                    force: options?.force
                })

                if (!itemsForRelation.length) {
                    if (mode === 'on-mount' && stableItems.length > 0) markDone.push(doneKey)
                    return
                }

                const includeArg = { [name]: value } as Record<string, unknown>
                tasks.push(engine.prefetchRelations(
                    itemsForRelation,
                    includeArg,
                    relations as any,
                    resolveStoreStable,
                    DEFAULT_PREFETCH_OPTIONS
                ))

                if (mode === 'on-mount') markDone.push(doneKey)
            })

            await Promise.all(tasks)
            markDone.forEach(key => prefetchDoneRef.current.add(key))
        } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error))
            patchState({ error: normalizedError })
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

    useEffect(() => {
        let cancelled = false

        const run = async () => {
            await prefetchAndProject({ cancelled: () => cancelled })
        }

        void run()
        return () => { cancelled = true }
    }, [stableItems, includeKey, relations, resolveStoreStable, resolveEngine])

    const [liveTick, setLiveTick] = useState(0)
    useEffect(() => {
        if (!liveInclude || !relations || !resolveStoreRef.current) return

        const engine = resolveEngine(liveInclude)
        const tokens = engine
            ? engine.collectRelationStoreTokens(liveInclude, relations as any)
            : collectRelationTokensFromInclude(liveInclude, relationMap)

        if (!tokens.length) return

        const unsubscribers: Array<() => void> = []
        tokens.forEach(token => {
            const store = resolveStoreStable(token)
            if (!store) return
            const source = getStoreBindings(store as any, 'useRelations').source
            const subscribe = createBatchedSubscribe((listener: () => void) => source.subscribe(listener))
            const unsubscribe = subscribe(() => setLiveTick(current => current + 1))
            unsubscribers.push(unsubscribe)
        })

        return () => {
            unsubscribers.forEach(unsubscribe => unsubscribe())
        }
    }, [includeKey, liveInclude, relations, relationMap, resolveEngine, resolveStoreStable])

    useEffect(() => {
        patchState({ data: project(stableItems) })
    }, [stableItems, includeKey, relations, resolveStoreStable, resolveEngine, liveTick])

    const refetch = () => prefetchAndProject({ force: true })

    return { data: state.data, loading: state.loading, error: state.error, refetch }
}
