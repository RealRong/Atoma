import { useCallback, useEffect, useMemo, useState } from 'react'
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
    lastAccessAt: number
}

const REMOTE_QUERY_CACHE = new WeakMap<object, Map<string, CacheEntry<Entity>>>()
const FALLBACK_QUERY_CACHE = new Map<string, CacheEntry<Entity>>()
const REMOTE_CACHE_TTL_MS = 5 * 60 * 1000
const REMOTE_CACHE_MAX_ENTRIES = 200

function normalizeResult<T extends Entity>(value: unknown): { data: T[]; pageInfo?: PageInfo } {
    if (!value || typeof value !== 'object') {
        return { data: [] }
    }
    const candidate = value as { data?: unknown; pageInfo?: PageInfo }
    return Array.isArray(candidate.data)
        ? { data: candidate.data as T[], pageInfo: candidate.pageInfo }
        : { data: [] }
}

function shouldEvictEntry<T extends Entity>(entry: CacheEntry<T>, now: number): boolean {
    return !entry.promise
        && entry.subscribers.size === 0
        && now - entry.lastAccessAt > REMOTE_CACHE_TTL_MS
}

function cleanupCache<T extends Entity>(cache: Map<string, CacheEntry<T>>, now: number) {
    cache.forEach((entry, key) => {
        if (shouldEvictEntry(entry, now)) {
            cache.delete(key)
        }
    })

    if (cache.size <= REMOTE_CACHE_MAX_ENTRIES) return

    const candidates: Array<[string, CacheEntry<T>]> = []
    cache.forEach((entry, key) => {
        if (!entry.promise && entry.subscribers.size === 0) {
            candidates.push([key, entry])
        }
    })

    candidates.sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt)
    const overflow = cache.size - REMOTE_CACHE_MAX_ENTRIES
    for (let index = 0; index < overflow && index < candidates.length; index += 1) {
        cache.delete(candidates[index][0])
    }
}

function getRuntimeCache(runtime?: object | null): Map<string, CacheEntry<Entity>> {
    if (!runtime) return FALLBACK_QUERY_CACHE
    const existing = REMOTE_QUERY_CACHE.get(runtime)
    if (existing) return existing
    const next = new Map<string, CacheEntry<Entity>>()
    REMOTE_QUERY_CACHE.set(runtime, next)
    return next
}

function getOrCreateEntry<T extends Entity>(runtime: object | null, key: string): CacheEntry<T> {
    const cache = getRuntimeCache(runtime) as unknown as Map<string, CacheEntry<T>>
    const now = Date.now()
    cleanupCache(cache, now)

    const existing = cache.get(key)
    if (existing) {
        existing.lastAccessAt = now
        return existing
    }

    const next: CacheEntry<T> = {
        state: {
            isFetching: false,
            error: undefined,
            pageInfo: undefined,
            data: undefined
        },
        subscribers: new Set(),
        promise: null,
        lastAccessAt: now
    }
    cache.set(key, next)
    cleanupCache(cache, now)
    return next
}

function publish<T extends Entity>(entry: CacheEntry<T>, patch: Partial<RemoteState<T>>) {
    entry.lastAccessAt = Date.now()
    entry.state = { ...entry.state, ...patch }
    entry.subscribers.forEach((listener) => listener(entry.state))
}

export function useRemoteQuery<T extends Entity, Relations = {}>(args: {
    store: Store<T, Relations>
    options?: Query<T>
    enabled?: boolean
}): UseRemoteQueryResult<T> {
    const enabled = args.enabled !== false
    const bindings = getStoreBindings(args.store, 'useRemoteQuery')
    const storeName = bindings.name
    const runtime = bindings.runtime as object
    const optionsKey = useMemo(() => stableStringify(args.options), [args.options])
    const key = `${storeName}:remoteQuery:${optionsKey}`

    const entry = useMemo(
        () => getOrCreateEntry<T>(runtime, key),
        [runtime, key]
    )
    const [state, setState] = useState<RemoteState<T>>(() => entry.state)

    useEffect(() => {
        const subscriber = (next: RemoteState<T>) => setState(next)
        entry.subscribers.add(subscriber)
        entry.lastAccessAt = Date.now()
        setState(entry.state)
        return () => {
            entry.subscribers.delete(subscriber)
            entry.lastAccessAt = Date.now()
        }
    }, [entry])

    const runFetch = useCallback(async (query: Query<T> | undefined, mode: 'refetch' | 'fetchMore'): Promise<T[]> => {
        if (!enabled) return []
        if (entry.promise) return entry.promise

        publish(entry, {
            isFetching: true,
            ...(mode === 'refetch' ? { error: undefined } : {})
        })

        const currentPromise = args.store.query(query ?? {})
            .then((result) => {
                const { data, pageInfo } = normalizeResult<T>(result)
                publish(entry, {
                    isFetching: false,
                    error: undefined,
                    pageInfo,
                    data: mode === 'fetchMore'
                        ? [...(entry.state.data ?? []), ...data]
                        : data
                })
                return data
            })
            .catch((error: unknown) => {
                const normalized = error instanceof Error ? error : new Error(String(error))
                publish(entry, {
                    isFetching: false,
                    error: normalized
                })
                throw normalized
            })
            .finally(() => {
                entry.promise = null
                entry.lastAccessAt = Date.now()
            })

        entry.promise = currentPromise
        return currentPromise
    }, [args.store, enabled, entry])

    useEffect(() => {
        if (!enabled) return
        runFetch(args.options, 'refetch').catch(() => {
            // error already published
        })
    }, [args.options, enabled, key, runFetch])

    return {
        ...state,
        refetch: () => runFetch(args.options, 'refetch'),
        fetchMore: (options: Query<T>) => runFetch(options, 'fetchMore')
    }
}
