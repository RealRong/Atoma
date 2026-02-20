import { useEffect, useMemo, useState } from 'react'
import { stableStringify } from 'atoma-shared'
import type { Entity, Store, PageInfo, Query } from 'atoma-types/core'
import { getStoreBindings } from 'atoma-types/internal'

type RemoteState<T extends Entity> = Readonly<{
    isFetching: boolean
    error?: Error
    pageInfo?: PageInfo
    data?: T[]
}>

type UseRemoteQueryResult<T extends Entity> = RemoteState<T> & Readonly<{
    refetch: () => Promise<T[]>
    fetchMore: (options: Query<T>) => Promise<T[]>
}>

type CacheEntry<T extends Entity> = {
    state: RemoteState<T>
    subscribers: Set<(state: RemoteState<T>) => void>
    promise: Promise<T[]> | null
}

const REMOTE_QUERY_CACHE = new WeakMap<object, Map<string, CacheEntry<any>>>()
const FALLBACK_QUERY_CACHE = new Map<string, CacheEntry<any>>()

function stripRuntimeOptions(options?: any) {
    if (!options) return undefined
    const { fetchPolicy: _fetchPolicy, result: _result, include: _include, ...rest } = options
    return rest
}

function normalizeResult<T extends Entity>(res: any): { data: T[]; pageInfo?: PageInfo } {
    if (res && Array.isArray(res.data)) return { data: res.data, pageInfo: res.pageInfo }
    return { data: [] }
}

function getRuntimeCache(runtime?: object | null): Map<string, CacheEntry<any>> {
    if (!runtime) return FALLBACK_QUERY_CACHE
    const existing = REMOTE_QUERY_CACHE.get(runtime)
    if (existing) return existing
    const next = new Map<string, CacheEntry<any>>()
    REMOTE_QUERY_CACHE.set(runtime, next)
    return next
}

function getOrCreateEntry<T extends Entity>(runtime: object | null, key: string): CacheEntry<T> {
    const cache = getRuntimeCache(runtime)
    const existing = cache.get(key)
    if (existing) return existing
    const next: CacheEntry<T> = {
        state: { isFetching: false, error: undefined, pageInfo: undefined, data: undefined },
        subscribers: new Set(),
        promise: null
    }
    cache.set(key, next)
    return next
}

function publish<T extends Entity>(entry: CacheEntry<T>, patch: Partial<RemoteState<T>>) {
    entry.state = { ...entry.state, ...patch }
    entry.subscribers.forEach(fn => fn(entry.state))
}

export function useRemoteQuery<T extends Entity, Relations = {}>(args: {
    store: Store<T, Relations>
    options?: Query<T>
    enabled?: boolean
}): UseRemoteQueryResult<T> {
    const enabled = args.enabled !== false
    const bindings = getStoreBindings(args.store, 'useRemoteQuery')
    const storeName = bindings.name
    const runtime = bindings.scope

    const key = useMemo(() => {
        const optionsKey = stableStringify(stripRuntimeOptions(args.options))
        return `${storeName}:remoteQuery:${optionsKey}`
    }, [storeName, args.options])

    const entry = useMemo(() => getOrCreateEntry<T>(runtime as unknown as object | null, key), [runtime, key])
    const [state, setState] = useState<RemoteState<T>>(() => entry.state)

    useEffect(() => {
        const sub = (next: RemoteState<T>) => setState(next)
        entry.subscribers.add(sub)
        setState(entry.state)
        return () => {
            entry.subscribers.delete(sub)
        }
    }, [entry])

    const runFetch = async (options: Query<T> | undefined, mode: 'refetch' | 'fetchMore'): Promise<T[]> => {
        if (!enabled) return []

        if (entry.promise) return entry.promise

        publish(entry, {
            isFetching: true,
            ...(mode === 'refetch' ? { error: undefined } : {})
        })

        const p = args.store.query(options ?? {})
            .then(async (res: any) => {
                const { data, pageInfo } = normalizeResult<T>(res)
                publish(entry, {
                    isFetching: false,
                    error: undefined,
                    pageInfo,
                    data: mode === 'fetchMore' ? [...(entry.state.data ?? []), ...data] : data
                })
                return data
            })
            .catch((err: any) => {
                const e = err instanceof Error ? err : new Error(String(err))
                publish(entry, { isFetching: false, error: e })
                throw e
            })
            .finally(() => {
                entry.promise = null
            })

        entry.promise = p
        return p
    }

    useEffect(() => {
        if (!enabled) return
        runFetch(args.options, 'refetch').catch(() => {
            // error is stored in state
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, enabled])

    const refetch = () => runFetch(args.options, 'refetch')
    const fetchMore = (moreOptions: Query<T>) => runFetch(moreOptions, 'fetchMore')

    return {
        ...state,
        refetch,
        fetchMore
    }
}
