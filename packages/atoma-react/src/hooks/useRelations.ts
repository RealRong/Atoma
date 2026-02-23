import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stableStringify } from 'atoma-shared'
import { buildRelationPlan, collectPlanStoreTokens } from 'atoma-core/relations'
import type {
    Entity,
    Store,
    Query,
    RelationIncludeInput,
    RelationMap,
    StoreReadOptions,
    StoreToken,
    WithRelations
} from 'atoma-types/core'
import type { RelationEngine, RelationInclude, StoreMap } from 'atoma-types/runtime'
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

type StoreStatesCacheEntry = {
    includeKey: string
    tokensKey: string
    liveTick: number
    states: ReadonlyMap<StoreToken, StoreMap>
}

type RelationStore = Store<Entity>

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
    include: RelationInclude,
    relations: RelationMap<T> | undefined,
    resolveStore?: (name: StoreToken) => RelationStore | undefined
): UseRelationsResult<T> {
    const resolveStoreRef = useRef(resolveStore)
    const relationRef = useRef<RelationEngine | undefined>(undefined)
    const storeStatesCacheRef = useRef<{ live?: StoreStatesCacheEntry; snapshot?: StoreStatesCacheEntry }>({})

    useEffect(() => {
        resolveStoreRef.current = resolveStore
        relationRef.current = undefined
        storeStatesCacheRef.current = {}
    }, [resolveStore])

    useEffect(() => {
        relationRef.current = undefined
    }, [relations])

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
        const query = store.query.bind(store)
        const getMany = store.getMany.bind(store)

        const wrapped: RelationStore = {
            ...store,
            query: (queryInput: Query<Entity>) => {
                const key = `rel:query:${storeName}:${stableStringify(queryInput)}`
                return dedupePrefetch(key, () => Promise.resolve(query(queryInput)))
            },
            getMany: (ids: EntityId[], options?: StoreReadOptions) => {
                const normalizedIds = Array.isArray(ids)
                    ? [...new Set(ids.map(String))].sort()
                    : []
                const key = `rel:getMany:${storeName}:${stableStringify(normalizedIds)}`
                return dedupePrefetch(key, () => Promise.resolve(getMany(ids, options)))
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

    const resolveRelation = useCallback((tokens: readonly StoreToken[]): RelationEngine | undefined => {
        if (relationRef.current) return relationRef.current
        if (!tokens.length || !resolveStoreRef.current) return undefined

        for (const token of tokens) {
            const store = resolveStoreStable(token)
            if (!store) continue
            const bindings = getStoreBindings(store, 'useRelations')
            relationRef.current = bindings.relation
            return bindings.relation
        }

        return undefined
    }, [resolveStoreStable])

    const includePlan = useMemo(() => normalizeInclude(include), [include])
    const { includeKey, effectiveInclude, liveInclude, snapshotInclude, snapshotNames } = includePlan
    const stableItems = useShallowStableArray(items)
    const relationPlans = useMemo(() => {
        const effectiveEntries = buildRelationPlan(stableItems, effectiveInclude, relationMap)
        const liveEntries = buildRelationPlan(stableItems, liveInclude, relationMap)
        const snapshotEntries = buildRelationPlan(stableItems, snapshotInclude, relationMap)

        return {
            effectiveEntries,
            liveEntries,
            snapshotEntries,
            effectiveTokens: collectPlanStoreTokens(effectiveEntries),
            liveTokens: collectPlanStoreTokens(liveEntries),
            snapshotTokens: collectPlanStoreTokens(snapshotEntries)
        }
    }, [stableItems, effectiveInclude, liveInclude, snapshotInclude, relationMap])

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
    }, [includeKey, relations])

    const collectStoreStates = (
        tokens: StoreToken[],
        mode: 'live' | 'snapshot'
    ): ReadonlyMap<StoreToken, StoreMap> => {
        if (!resolveStoreRef.current) return new Map()
        const tokensKey = stableStringify(tokens)

        const cached = storeStatesCacheRef.current[mode]
        if (
            cached
            && cached.includeKey === includeKey
            && cached.liveTick === liveTick
            && cached.tokensKey === tokensKey
        ) {
            return cached.states
        }

        if (!tokens.length) {
            const empty = new Map<StoreToken, StoreMap>()
            storeStatesCacheRef.current[mode] = { includeKey, tokensKey, liveTick, states: empty }
            return empty
        }

        const states = new Map<StoreToken, StoreMap>()
        tokens.forEach(token => {
            const store = resolveStoreStable(token)
            if (!store) return

            const bindings = getStoreBindings(store, 'useRelations')
            states.set(token, bindings.state())
        })

        storeStatesCacheRef.current[mode] = { includeKey, tokensKey, liveTick, states }
        return states
    }

    const project = (source: T[]): T[] => {
        if (!effectiveInclude || !relations || source.length === 0) return source

        const projectedLive = (() => {
            if (!liveInclude || relationPlans.liveEntries.length === 0) return source

            const relation = resolveRelation(relationPlans.liveTokens)
            if (!relation) return source

            return relation.project(
                source,
                liveInclude,
                relationMap,
                collectStoreStates(relationPlans.liveTokens, 'live')
            )
        })()

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
        if (!snapshotInclude || !snapshotNames.length || !relations || source.length === 0) return
        if (relationPlans.snapshotEntries.length === 0) return

        const relation = resolveRelation(relationPlans.snapshotTokens)
        if (!relation) return

        const projected = relation.project(
            source,
            snapshotInclude,
            relationMap,
            collectStoreStates(relationPlans.snapshotTokens, 'snapshot')
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
            const err = new Error('[Atoma] useRelations: 缺少 resolveStore（StoreToken -> Store），无法解析 include 关系')
            setState({ data: stableItems, loading: false, error: err })
            prevIdsRef.current = currentIds
            return stableItems
        }

        const relation = relationPlans.effectiveEntries.length
            ? resolveRelation(relationPlans.effectiveTokens)
            : undefined
        if (relationPlans.effectiveEntries.length && !relation) {
            const err = new Error('[Atoma] useRelations: store 缺少 Relation 绑定，无法执行关系预取/投影')
            setState({ data: stableItems, loading: false, error: err })
            prevIdsRef.current = currentIds
            return stableItems
        }

        patchState({ loading: true, error: undefined })
        try {
            const tasks: Array<Promise<void>> = []
            const markDone: string[] = []

            if (relation) {
                const entries = (effectiveInclude && typeof effectiveInclude === 'object')
                    ? Object.entries(effectiveInclude)
                    : []

                entries.forEach(([name, value]) => {
                    if (value === false || value === undefined || value === null) return

                    const relConfig = relationMap?.[name]
                    if (!relConfig) return

                    const mode = resolvePrefetchMode(relConfig, value, name)
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

                    const includeArg = { [name]: value } as RelationInclude
                    tasks.push(relation.prefetch(
                        itemsForRelation,
                        includeArg,
                        relationMap,
                        resolveStoreStable,
                        DEFAULT_PREFETCH_OPTIONS
                    ))

                    if (mode === 'on-mount') markDone.push(doneKey)
                })
            }

            await Promise.all(tasks)
            if (options?.cancelled?.()) return stableItems
            markDone.forEach(key => prefetchDoneRef.current.add(key))
        } catch (error) {
            if (options?.cancelled?.()) return stableItems
            const normalizedError = error instanceof Error ? error : new Error(String(error))
            patchState({ error: normalizedError })
        } finally {
            if (!options?.cancelled?.()) {
                patchState({ loading: false })
            }
        }

        if (options?.cancelled?.()) return stableItems

        prevIdsRef.current = currentIds
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
    }, [stableItems, includeKey, relations, resolveStoreStable, resolveRelation, relationPlans])

    useEffect(() => {
        if (!liveInclude || !relations || !resolveStoreRef.current) return
        if (relationPlans.liveEntries.length === 0) return

        if (!resolveRelation(relationPlans.liveTokens)) return
        const tokens = relationPlans.liveTokens

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
    }, [includeKey, liveInclude, relations, resolveRelation, resolveStoreStable, relationPlans])

    useEffect(() => {
        patchState({ data: project(stableItems) })
    }, [stableItems, includeKey, relations, resolveStoreStable, resolveRelation, liveTick, relationPlans])

    const refetch = () => prefetchAndProject({ force: true })

    return { data: state.data, loading: state.loading, error: state.error, refetch }
}
