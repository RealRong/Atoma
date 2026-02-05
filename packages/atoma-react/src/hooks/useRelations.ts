import { useEffect, useMemo, useRef, useState } from 'react'
import { Relations } from 'atoma-core'
import { stableStringify } from 'atoma-shared'
import type * as Types from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { getStoreBindings } from 'atoma-types/internal'
import { useShallowStableArray } from './useShallowStableArray'
import { createBatchedSubscribe } from './internal/batchedSubscribe'

const DEFAULT_PREFETCH_OPTIONS = { onError: 'partial', timeout: 5000, maxConcurrency: 10 } as const

export interface UseRelationsResult<T extends Types.Entity> {
    data: T[]
    loading: boolean
    error?: Error
    refetch: () => Promise<T[]>
}

export function useRelations<T extends Types.Entity, Relations>(
    items: T[],
    include: undefined,
    relations: Relations | undefined,
    resolveStore?: (name: Types.StoreToken) => Types.IStore<any, any> | undefined
): UseRelationsResult<T>

export function useRelations<T extends Types.Entity, Relations, const Include extends Types.RelationIncludeInput<Relations>>(
    items: T[],
    include: Include,
    relations: Relations | undefined,
    resolveStore?: (name: Types.StoreToken) => Types.IStore<any, any> | undefined
): UseRelationsResult<keyof Include extends never ? T : Types.WithRelations<T, Relations, Include>>

export function useRelations<T extends Types.Entity>(
    items: T[],
    include: Record<string, any> | undefined,
    relations: any | undefined,
    resolveStore?: (name: Types.StoreToken) => Types.IStore<any, any> | undefined
): UseRelationsResult<any> {
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

    const getStoreMap = (storeToken: Types.StoreToken) => {
        if (!resolveStore) return undefined
        const store = resolveStore(storeToken)
        if (!store) return undefined
        const bindings = getStoreBindings(store as any, 'useRelations')
        return {
            map: bindings.source.getSnapshot() as Map<EntityId, any>,
            indexes: bindings.indexes
        }
    }

    const project = (source: T[]): T[] => {
        if (!effectiveInclude || !relations || !resolveStore || source.length === 0) return source

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
        if (!snapshotInclude || !snapshotNames.length || !relations || !resolveStore || source.length === 0) return

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

    const prefetchAndProject = async (options?: { cancelled?: () => boolean }): Promise<T[]> => {
        if (!effectiveInclude || !relations || stableItems.length === 0) {
            clearSnapshot()
            setState({ data: stableItems, loading: false, error: undefined })
            return stableItems
        }

        if (!resolveStore) {
            const err = new Error('[Atoma] useRelations: 缺少 resolveStore（StoreToken -> IStore），无法解析 include 关系')
            setState({ data: stableItems, loading: false, error: err })
            return stableItems
        }

        patchState({ loading: true, error: undefined })
        try {
            await Relations.RelationResolver.prefetchBatch(
                stableItems,
                effectiveInclude,
                relations,
                resolveStore,
                DEFAULT_PREFETCH_OPTIONS
            )
        } catch (err: any) {
            const e = err instanceof Error ? err : new Error(String(err))
            patchState({ error: e })
        } finally {
            if (!options?.cancelled?.()) patchState({ loading: false })
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
    }, [stableItems, includeKey, relations, resolveStore])

    // live 订阅：监听相关 store map 变化
    const [liveTick, setLiveTick] = useState(0)
    useEffect(() => {
        if (!liveInclude || !relations || !resolveStore) return

        const tokens = Relations.collectRelationStoreTokens(liveInclude, relations)
        if (!tokens.length) return

        const unsubscribers: Array<() => void> = []
        tokens.forEach(token => {
            const store = resolveStore(token)
            if (!store) return
            const source = getStoreBindings(store as any, 'useRelations').source
            const subscribe = createBatchedSubscribe((listener: () => void) => source.subscribe(listener))
            const unsub = subscribe(() => setLiveTick(t => t + 1))
            unsubscribers.push(unsub)
        })

        return () => {
            unsubscribers.forEach(fn => fn())
        }
    }, [includeKey, relations, resolveStore])

    // liveTick 变化：仅重算 live 投影，并合并 snapshot
    useEffect(() => {
        patchState({ data: project(stableItems) })
    }, [stableItems, includeKey, relations, resolveStore, liveTick])

    const refetch = () => prefetchAndProject()

    return { data: state.data, loading: state.loading, error: state.error, refetch }
}
