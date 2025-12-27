import { useEffect, useMemo, useRef, useState } from 'react'
import { Core } from '#core'
import type { Entity, IStore, RelationIncludeInput, StoreKey, StoreToken, WithRelations } from '#core'

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
    const effectiveInclude = include && typeof include === 'object' && Object.keys(include).length === 0
        ? undefined
        : include

    const includeKey = useMemo(() => Core.query.stableStringify(effectiveInclude), [effectiveInclude])

    const [data, setData] = useState<T[]>(items)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<Error | undefined>(undefined)

    const snapshotRef = useRef<Map<StoreKey, Record<string, any>>>(new Map())
    const snapshotNamesRef = useRef<string[]>([])

    const { liveInclude, snapshotInclude, snapshotNames } = useMemo(() => {
        const outLive: Record<string, any> = {}
        const outSnapshot: Record<string, any> = {}

        if (effectiveInclude) {
            Object.entries(effectiveInclude).forEach(([name, opts]) => {
                if (opts === false || opts === undefined || opts === null) return
                const live = typeof opts === 'object' ? (opts as any).live !== false : true
                if (live) outLive[name] = opts
                else outSnapshot[name] = opts
            })
        }

        const snapNames = Object.keys(outSnapshot)

        return {
            liveInclude: Object.keys(outLive).length ? outLive : undefined,
            snapshotInclude: snapNames.length ? outSnapshot : undefined,
            snapshotNames: snapNames
        }
    }, [includeKey])

    // include/relations 变化时先清空快照，避免短暂合并旧数据
    useEffect(() => {
        snapshotRef.current = new Map()
        snapshotNamesRef.current = []
    }, [includeKey, relations])

    const getStoreMap = (storeToken: StoreToken): Map<StoreKey, any> | undefined => {
        if (!resolveStore) return undefined
        const store = resolveStore(storeToken)
        if (!store) return undefined
        const handle = Core.store.getHandle(store)
        if (!handle || typeof handle.jotaiStore.get !== 'function') return undefined
        return handle.jotaiStore.get(handle.atom) as Map<StoreKey, any>
    }

    const project = (source: T[]): T[] => {
        if (!effectiveInclude || !relations || !resolveStore || source.length === 0) return source

        const projectedLive = Core.relations.projectRelationsBatch(
            source,
            liveInclude,
            relations,
            getStoreMap
        ) as T[]

        const names = snapshotNamesRef.current
        if (!names.length) return projectedLive

        const snapshot = snapshotRef.current
        return projectedLive.map(item => {
            const cached = snapshot.get((item as any).id as StoreKey)
            if (!cached) return item
            return { ...item, ...cached } as any
        })
    }

    const buildSnapshot = (source: T[]) => {
        snapshotRef.current = new Map()
        snapshotNamesRef.current = []

        if (!snapshotInclude || !snapshotNames.length || !relations || !resolveStore || source.length === 0) return

        const projected = Core.relations.projectRelationsBatch(source, snapshotInclude, relations, getStoreMap) as any[]

        const next = new Map<StoreKey, Record<string, any>>()
        projected.forEach(item => {
            const id = (item as any)?.id as StoreKey | undefined | null
            if (id === undefined || id === null) return
            const values: Record<string, any> = {}
            snapshotNames.forEach(name => { values[name] = item[name] })
            next.set(id, values)
        })

        snapshotRef.current = next
        snapshotNamesRef.current = snapshotNames
    }

    const runPrefetch = async (): Promise<T[]> => {
        if (!effectiveInclude || !relations || items.length === 0) {
            snapshotRef.current = new Map()
            snapshotNamesRef.current = []
            setError(undefined)
            setLoading(false)
            setData(items)
            return items
        }

        if (!resolveStore) {
            const err = new Error('[Atoma] useRelations: 缺少 resolveStore（StoreToken -> IStore），无法解析 include 关系')
            setError(err)
            setLoading(false)
            setData(items)
            return items
        }

        setLoading(true)
        setError(undefined)

        try {
            await Core.relations.RelationResolver.prefetchBatch(
                items,
                effectiveInclude,
                relations,
                resolveStore,
                { onError: 'partial', timeout: 5000, maxConcurrency: 10 }
            )
        } catch (err: any) {
            const e = err instanceof Error ? err : new Error(String(err))
            setError(e)
        } finally {
            setLoading(false)
        }

        buildSnapshot(items)
        const projected = project(items)
        setData(projected)
        return projected
    }

    // items/include/relations 变化：触发 prefetch（并刷新 snapshot）
    useEffect(() => {
        let cancelled = false

        const run = async () => {
            if (!effectiveInclude || !relations || items.length === 0) {
                snapshotRef.current = new Map()
                snapshotNamesRef.current = []
                setError(undefined)
                setLoading(false)
                setData(items)
                return
            }

            if (!resolveStore) {
                const err = new Error('[Atoma] useRelations: 缺少 resolveStore（StoreToken -> IStore），无法解析 include 关系')
                setError(err)
                setLoading(false)
                setData(items)
                return
            }

            setLoading(true)
            setError(undefined)

            try {
                await Core.relations.RelationResolver.prefetchBatch(
                    items,
                    effectiveInclude,
                    relations,
                    resolveStore,
                    { onError: 'partial', timeout: 5000, maxConcurrency: 10 }
                )
            } catch (err: any) {
                const e = err instanceof Error ? err : new Error(String(err))
                setError(e)
            } finally {
                if (!cancelled) setLoading(false)
            }

            if (cancelled) return
            buildSnapshot(items)
            setData(project(items))
        }

        run()
        return () => { cancelled = true }
    }, [items, includeKey, relations, resolveStore])

    // live 订阅：监听相关 store map 变化
    const [liveTick, setLiveTick] = useState(0)
    useEffect(() => {
        if (!liveInclude || !relations || !resolveStore) return

        const tokens = Core.relations.collectRelationStoreTokens(liveInclude, relations)
        if (!tokens.length) return

        const unsubscribers: Array<() => void> = []
        tokens.forEach(token => {
            const store = resolveStore(token)
            if (!store) return
            const handle = Core.store.getHandle(store)
            if (!handle || typeof handle.jotaiStore.sub !== 'function') return
            const unsub = handle.jotaiStore.sub(handle.atom, () => setLiveTick(t => t + 1))
            unsubscribers.push(unsub)
        })

        return () => {
            unsubscribers.forEach(fn => fn())
        }
    }, [includeKey, relations, resolveStore])

    // liveTick 变化：仅重算 live 投影，并合并 snapshot
    useEffect(() => {
        setData(project(items))
    }, [items, includeKey, relations, resolveStore, liveTick])

    const refetch = () => runPrefetch()

    return { data, loading, error, refetch }
}
