import { useCallback, useEffect, useRef, useState } from 'react'
import { stableStringify } from '@atoma-js/shared'
import type {
    Entity,
    Store,
    Query,
    RelationIncludeInput,
    RelationMap,
    StoreReadOptions,
    StoreToken,
    WithRelations
} from '@atoma-js/types/core'
import type { RelationEngine, RelationInclude, StoreMap } from '@atoma-js/types/runtime'
import type { EntityId } from '@atoma-js/types/shared'
import { getStoreBindings } from '@atoma-js/types/internal'
import { useShallowStableArray } from './useShallowStableArray'
import { createBatchedSubscribe } from './internal/batchedSubscribe'
import { dedupeTask } from './internal/remoteQueryCache'
import { mergeSnapshotValues, buildSnapshotValues } from './internal/relationProjection'
import { useRelationPlans } from './internal/useRelationPlans'
import {
    buildPrefetchDoneKey,
    collectCurrentAndNewIds,
    filterStableItemsForRelation,
    getEntityId,
    resolvePrefetchMode
} from './internal/relationInclude'
import { useStableIncludeBucket } from './internal/useStableIncludeBucket'

const DEFAULT_PREFETCH_OPTIONS = { onError: 'partial', timeout: 5000, maxConcurrency: 10 } as const
const PREFETCH_DEDUP_TTL_MS = 300

type StoreStatesCacheEntry = Readonly<{
    includeKey: string
    tokensKey: string
    versionsKey: string
    states: ReadonlyMap<StoreToken, StoreMap>
}>

type RelationStore = Store<Entity>

export interface UseRelationsResult<T extends Entity> {
    data: T[]
    loading: boolean
    error?: Error
}

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

    const prefetchStoreCacheRef = useRef<WeakMap<object, RelationStore>>(new WeakMap())
    const prevIdsRef = useRef<Set<EntityId>>(new Set())
    const prefetchDoneRef = useRef<Set<string>>(new Set())

    const resolveStoreStable = useCallback((name: StoreToken): RelationStore | undefined => {
        return resolveStoreRef.current?.(name)
    }, [])

    const resolveStoreForPrefetch = useCallback((name: StoreToken): RelationStore | undefined => {
        const store = resolveStoreStable(name)
        if (!store) return store

        const cached = prefetchStoreCacheRef.current.get(store as object)
        if (cached) return cached

        const bindings = getStoreBindings(store, 'useRelations')
        const storeName = bindings.name
        const runtime = bindings.runtime as object
        const query = store.query.bind(store)
        const getMany = store.getMany.bind(store)

        const wrapped: RelationStore = {
            ...store,
            query: (queryInput: Query<Entity>) => {
                const key = `rel:query:${storeName}:${stableStringify(queryInput)}`
                return dedupeTask({
                    runtime,
                    key,
                    dedupeTtlMs: PREFETCH_DEDUP_TTL_MS,
                    task: () => Promise.resolve(query(queryInput))
                })
            },
            getMany: (ids: EntityId[], options?: StoreReadOptions) => {
                const normalizedIds = Array.isArray(ids)
                    ? [...new Set(ids.map(String))].sort()
                    : []
                const key = `rel:getMany:${storeName}:${stableStringify(normalizedIds)}`
                return dedupeTask({
                    runtime,
                    key,
                    dedupeTtlMs: PREFETCH_DEDUP_TTL_MS,
                    task: () => Promise.resolve(getMany(ids, options))
                })
            }
        }

        prefetchStoreCacheRef.current.set(store as object, wrapped)
        return wrapped
    }, [resolveStoreStable])

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

    const includePlan = useStableIncludeBucket(include)
    const { includeKey, effectiveInclude, liveInclude, snapshotInclude, snapshotNames } = includePlan
    const stableItems = useShallowStableArray(items)
    const relationMap = relations

    const relationPlans = useRelationPlans({
        items: stableItems,
        effectiveInclude,
        liveInclude,
        snapshotInclude,
        relationMap
    })

    type State = { data: T[]; loading: boolean; error?: Error }
    const [state, setState] = useState<State>(() => ({
        data: stableItems,
        loading: false,
        error: undefined
    }))
    const [liveTick, setLiveTick] = useState(0)
    const patchState = (patch: Partial<State>) => setState((prev) => ({ ...prev, ...patch }))

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

        const resolved: Array<{ token: StoreToken; bindings: ReturnType<typeof getStoreBindings> }> = []
        tokens.forEach((token) => {
            const store = resolveStoreStable(token)
            if (!store) return
            resolved.push({
                token,
                bindings: getStoreBindings(store, 'useRelations')
            })
        })

        const versionsKey = resolved
            .map(({ token, bindings }) => `${String(token)}:${bindings.version()}`)
            .join('|')

        const cached = storeStatesCacheRef.current[mode]
        if (
            cached
            && cached.includeKey === includeKey
            && cached.tokensKey === tokensKey
            && cached.versionsKey === versionsKey
        ) {
            return cached.states
        }

        const states = new Map<StoreToken, StoreMap>()
        resolved.forEach(({ token, bindings }) => {
            states.set(token, bindings.state())
        })

        storeStatesCacheRef.current[mode] = {
            includeKey,
            tokensKey,
            versionsKey,
            states
        }
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

        return mergeSnapshotValues({
            items: projectedLive,
            snapshot: snapshotRef.current,
            getEntityId
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

        snapshotRef.current = buildSnapshotValues({
            items: projected,
            relationNames: snapshotNames,
            getEntityId
        })
        snapshotNamesRef.current = snapshotNames
    }

    const settleStableItems = (args: {
        currentIds: Set<EntityId>
        error?: Error
        clearSnapshot?: boolean
    }): T[] => {
        if (args.clearSnapshot) clearSnapshot()
        setState({
            data: stableItems,
            loading: false,
            error: args.error
        })
        prevIdsRef.current = args.currentIds
        return stableItems
    }

    const buildPrefetchJobs = (args: {
        relation: RelationEngine
        newIds: Set<EntityId>
    }): {
        tasks: Array<Promise<void>>
        markDone: string[]
    } => {
        const tasks: Array<Promise<void>> = []
        const markDone: string[] = []
        const entries = (effectiveInclude && typeof effectiveInclude === 'object')
            ? Object.entries(effectiveInclude)
            : []

        entries.forEach(([name, value]) => {
            if (value === false || value === undefined || value === null) return

            const relationConfig = relationMap?.[name]
            if (!relationConfig) return

            const mode = resolvePrefetchMode(relationConfig, value, name)
            if (mode === 'manual') return

            const doneKey = buildPrefetchDoneKey({
                includeKey,
                relationName: name
            })
            const shouldPrefetch = mode === 'on-change'
                || (!prefetchDoneRef.current.has(doneKey) && stableItems.length > 0)
            if (!shouldPrefetch) return

            const relationItems = filterStableItemsForRelation({
                items: stableItems,
                relationConfig,
                mode,
                newIds: args.newIds
            })
            if (!relationItems.length) {
                if (mode === 'on-mount' && stableItems.length > 0) markDone.push(doneKey)
                return
            }

            tasks.push(args.relation.prefetch(
                relationItems,
                { [name]: value } as RelationInclude,
                relationMap,
                resolveStoreForPrefetch,
                DEFAULT_PREFETCH_OPTIONS
            ))
            if (mode === 'on-mount') markDone.push(doneKey)
        })

        return { tasks, markDone }
    }

    const commitProjectedItems = (currentIds: Set<EntityId>): T[] => {
        prevIdsRef.current = currentIds
        buildSnapshot(stableItems)
        const projected = project(stableItems)
        patchState({ data: projected })
        return projected
    }

    const prefetchAndProject = async (options?: { cancelled?: () => boolean }): Promise<T[]> => {
        const { currentIds, newIds } = collectCurrentAndNewIds(stableItems, prevIdsRef.current)
        const isCancelled = () => options?.cancelled?.() === true

        if (!effectiveInclude || !relations || stableItems.length === 0) {
            return settleStableItems({
                currentIds,
                clearSnapshot: true
            })
        }

        if (!resolveStoreRef.current) {
            return settleStableItems({
                currentIds,
                error: new Error('[Atoma] useRelations: 缺少 resolveStore（StoreToken -> Store），无法解析 include 关系')
            })
        }

        const relation = relationPlans.effectiveEntries.length
            ? resolveRelation(relationPlans.effectiveTokens)
            : undefined
        if (relationPlans.effectiveEntries.length && !relation) {
            return settleStableItems({
                currentIds,
                error: new Error('[Atoma] useRelations: store 缺少 Relation 绑定，无法执行关系预取/投影')
            })
        }

        patchState({ loading: true, error: undefined })
        try {
            const { tasks, markDone } = relation
                ? buildPrefetchJobs({
                    relation,
                    newIds
                })
                : { tasks: [], markDone: [] }

            await Promise.all(tasks)
            if (isCancelled()) return stableItems
            markDone.forEach((key) => prefetchDoneRef.current.add(key))
        } catch (error) {
            if (isCancelled()) return stableItems
            const normalizedError = error instanceof Error ? error : new Error(String(error))
            patchState({ error: normalizedError })
        } finally {
            if (!isCancelled()) {
                patchState({ loading: false })
            }
        }

        if (isCancelled()) return stableItems
        return commitProjectedItems(currentIds)
    }

    useEffect(() => {
        let cancelled = false

        void prefetchAndProject({
            cancelled: () => cancelled
        })

        return () => {
            cancelled = true
        }
    }, [stableItems, includeKey, relations, resolveRelation, resolveStoreForPrefetch, relationPlans])

    useEffect(() => {
        if (!liveInclude || !relations || !resolveStoreRef.current) return
        if (relationPlans.liveEntries.length === 0) return
        if (!resolveRelation(relationPlans.liveTokens)) return

        const tokens = relationPlans.liveTokens
        if (!tokens.length) return

        const unsubscribers: Array<() => void> = []
        tokens.forEach((token) => {
            const store = resolveStoreStable(token)
            if (!store) return
            const source = getStoreBindings(store, 'useRelations').source
            const subscribe = createBatchedSubscribe((listener: () => void) => source.subscribe(listener))
            unsubscribers.push(subscribe(() => setLiveTick((value) => value + 1)))
        })

        return () => {
            unsubscribers.forEach((unsubscribe) => unsubscribe())
        }
    }, [includeKey, liveInclude, relations, resolveRelation, resolveStoreStable, relationPlans])

    useEffect(() => {
        patchState({ data: project(stableItems) })
    }, [stableItems, includeKey, relations, resolveRelation, liveTick, relationPlans])

    return {
        data: state.data,
        loading: state.loading,
        error: state.error,
    }
}
