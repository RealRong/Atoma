import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stableStringify } from 'atoma-shared'
import { collectRelationStoreTokens } from 'atoma-core/relations'
import type {
    Entity,
    IStore,
    Query,
    RelationIncludeInput,
    RelationMap,
    StoreToken,
    WithRelations
} from 'atoma-types/core'
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
    type RelationConfigLike,
    resolvePrefetchMode
} from './internal/relationInclude'

const DEFAULT_PREFETCH_OPTIONS = { onError: 'partial', timeout: 5000, maxConcurrency: 10 } as const
const PREFETCH_DEDUP_TTL_MS = 300

type PrefetchEntry = {
    promise: Promise<unknown>
    doneAt: number
}

type StoreStatesCacheEntry = {
    includeKey: string
    liveTick: number
    states: ReadonlyMap<StoreToken, RuntimeStoreMap>
}

type RelationTokensCacheEntry = {
    includeKey: string
    tokens: StoreToken[]
}

type RelationStore = IStore<Entity>

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
    resolveStore?: (name: StoreToken) => RelationStore | undefined
): UseRelationsResult<T>

export function useRelations<T extends Entity, Relations, const Include extends RelationIncludeInput<Relations>>(
    items: T[],
    include: Include,
    relations: Relations | undefined,
    resolveStore?: (name: StoreToken) => RelationStore | undefined
): UseRelationsResult<keyof Include extends never ? T : WithRelations<T, Relations, Include>>

export function useRelations<T extends Entity>(
    items: T[],
    include: Record<string, unknown> | undefined,
    relations: RelationMap<T> | undefined,
    resolveStore?: (name: StoreToken) => RelationStore | undefined
): UseRelationsResult<T> {
    const resolveStoreRef = useRef(resolveStore)
    const engineRef = useRef<RuntimeEngine | undefined>(undefined)
    const storeStatesCacheRef = useRef<{ live?: StoreStatesCacheEntry; snapshot?: StoreStatesCacheEntry }>({})
    const relationTokensCacheRef = useRef<{ live?: RelationTokensCacheEntry; snapshot?: RelationTokensCacheEntry }>({})

    useEffect(() => {
        resolveStoreRef.current = resolveStore
        storeStatesCacheRef.current = {}
        relationTokensCacheRef.current = {}
    }, [resolveStore])

    const prefetchCacheRef = useRef<Map<string, PrefetchEntry>>(new Map())
    const wrappedStoreCacheRef = useRef<WeakMap<object, RelationStore>>(new WeakMap())
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

    const resolveStoreStable = useCallback((name: StoreToken): RelationStore | undefined => {
        const store = resolveStoreRef.current?.(name)
        if (!store) return store

        const cached = wrappedStoreCacheRef.current.get(store as object)
        if (cached) return cached

        const storeName = normalizeStoreName(store, name)
        const query = typeof store.query === 'function' ? store.query.bind(store) : undefined
        const getMany = store.getMany.bind(store)

        const wrapped: RelationStore = {
            ...store,
            query: query
                ? (queryInput: Query<Entity>) => {
                    const key = `rel:query:${storeName}:${stableStringify(queryInput)}`
                    return dedupePrefetch(key, () => Promise.resolve(query(queryInput)))
                }
                : query,
            getMany: (ids: EntityId[], cache?: boolean) => {
                const normalizedIds = Array.isArray(ids)
                    ? [...new Set(ids.map(String))].sort()
                    : []
                const key = `rel:getMany:${storeName}:${stableStringify(normalizedIds)}:${cache ? '1' : '0'}`
                return dedupePrefetch(key, () => Promise.resolve(getMany(ids, cache)))
            }
        }

        const bindings = (store as unknown as Record<PropertyKey, unknown>)?.[STORE_BINDINGS]
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

    const relationMap = relations

    const resolveEngine = useCallback((includeArg: RuntimeRelationInclude): RuntimeEngine | undefined => {
        if (engineRef.current) return engineRef.current
        if (!includeArg || !relationMap || !resolveStoreRef.current) return undefined

        const tokens = collectRelationStoreTokens(includeArg, relationMap)
        for (const token of tokens) {
            const store = resolveStoreStable(token)
            if (!store) continue
            const bindings = getStoreBindings(store, 'useRelations')
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
    const [liveTick, setLiveTick] = useState(0)
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
        storeStatesCacheRef.current = {}
        relationTokensCacheRef.current = {}
    }, [includeKey, relations])

    const collectRelationTokens = (includeArg: RuntimeRelationInclude, mode: 'live' | 'snapshot'): StoreToken[] => {
        if (!relationMap) return []

        const cached = relationTokensCacheRef.current[mode]
        if (cached && cached.includeKey === includeKey) {
            return cached.tokens
        }

        const tokens = collectRelationStoreTokens(includeArg, relationMap)
        relationTokensCacheRef.current[mode] = { includeKey, tokens }
        return tokens
    }

    const collectStoreStates = (
        includeArg: RuntimeRelationInclude,
        mode: 'live' | 'snapshot'
    ): ReadonlyMap<StoreToken, RuntimeStoreMap> => {
        if (!resolveStoreRef.current || !relationMap) return new Map()

        const cached = storeStatesCacheRef.current[mode]
        if (cached && cached.includeKey === includeKey && cached.liveTick === liveTick) {
            return cached.states
        }

        const tokens = collectRelationTokens(includeArg, mode)
        if (!tokens.length) {
            const empty = new Map<StoreToken, RuntimeStoreMap>()
            storeStatesCacheRef.current[mode] = { includeKey, liveTick, states: empty }
            return empty
        }

        const states = new Map<StoreToken, RuntimeStoreMap>()
        tokens.forEach(token => {
            const store = resolveStoreStable(token)
            if (!store) return

            const bindings = getStoreBindings(store, 'useRelations')
            if (!engineRef.current) {
                engineRef.current = bindings.engine
            }

            states.set(token, {
                map: bindings.source.getSnapshot(),
                indexes: bindings.indexes
            })
        })

        storeStatesCacheRef.current[mode] = { includeKey, liveTick, states }
        return states
    }

    const project = (source: T[]): T[] => {
        if (!effectiveInclude || !relations || !resolveStoreRef.current || source.length === 0) return source

        const engine = resolveEngine(liveInclude)
        if (!engine) return source

        const projectedLive = engine.relation.project(
            source,
            liveInclude,
            relationMap,
            collectStoreStates(liveInclude, 'live')
        )

        const names = snapshotNamesRef.current
        if (!names.length) return projectedLive

        const snapshot = snapshotRef.current
        return projectedLive.map(item => {
            const id = getEntityId(item)
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

        const projected = engine.relation.project(
            source,
            snapshotInclude,
            relationMap,
            collectStoreStates(snapshotInclude, 'snapshot')
        )

        const next = new Map<EntityId, Record<string, unknown>>()
        projected.forEach(item => {
            const id = getEntityId(item)
            if (!id) return

            const record = item as unknown as Record<string, unknown>
            const values: Record<string, unknown> = {}
            snapshotNames.forEach(name => {
                values[name] = record[name]
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

                const relConfig = relationMap?.[name] as RelationConfigLike | undefined
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

                const includeArg = { [name]: value } as RuntimeRelationInclude
                tasks.push(engine.relation.prefetch(
                    itemsForRelation,
                    includeArg,
                    relationMap,
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

    useEffect(() => {
        if (!liveInclude || !relations || !resolveStoreRef.current) return

        const engine = resolveEngine(liveInclude)
        if (!engine) return
        const tokens = collectRelationTokens(liveInclude, 'live')

        if (!tokens.length) return

        const unsubscribers: Array<() => void> = []
        tokens.forEach(token => {
            const store = resolveStoreStable(token)
            if (!store) return
            const source = getStoreBindings(store, 'useRelations').source
            const subscribe = createBatchedSubscribe((listener: () => void) => source.subscribe(listener))
            const unsubscribe = subscribe(() => setLiveTick(current => current + 1))
            unsubscribers.push(unsubscribe)
        })

        return () => {
            unsubscribers.forEach(unsubscribe => unsubscribe())
        }
    }, [includeKey, liveInclude, relations, resolveEngine, resolveStoreStable])

    useEffect(() => {
        patchState({ data: project(stableItems) })
    }, [stableItems, includeKey, relations, resolveStoreStable, resolveEngine, liveTick])

    const refetch = () => prefetchAndProject({ force: true })

    return { data: state.data, loading: state.loading, error: state.error, refetch }
}
