import type { Entity, PageInfo } from 'atoma-types/core'

export type RemoteState<T extends Entity> = Readonly<{
    isFetching: boolean
    error?: Error
    pageInfo?: PageInfo
    data?: T[]
}>

export type CacheEntry<T extends Entity> = {
    state: RemoteState<T>
    subscribers: Set<(state: RemoteState<T>) => void>
    promise: Promise<T[]> | null
    lastAccessAt: number
}

const REMOTE_QUERY_CACHE = new WeakMap<object, Map<string, CacheEntry<Entity>>>()
const FALLBACK_QUERY_CACHE = new Map<string, CacheEntry<Entity>>()
const REMOTE_CACHE_TTL_MS = 5 * 60 * 1000
const REMOTE_CACHE_MAX_ENTRIES = 200

function shouldEvictEntry<T extends Entity>(entry: CacheEntry<T>, now: number): boolean {
    return !entry.promise
        && entry.subscribers.size === 0
        && now - entry.lastAccessAt > REMOTE_CACHE_TTL_MS
}

function cleanupCache<T extends Entity>(cache: Map<string, CacheEntry<T>>, now: number) {
    const candidates: Array<[string, CacheEntry<T>]> = []
    cache.forEach((entry, key) => {
        if (shouldEvictEntry(entry, now)) {
            cache.delete(key)
            return
        }
        if (!entry.promise && entry.subscribers.size === 0) {
            candidates.push([key, entry])
        }
    })

    const overflow = cache.size - REMOTE_CACHE_MAX_ENTRIES
    if (overflow <= 0) return

    candidates.sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt)
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

export function getOrCreateEntry<T extends Entity>(runtime: object | null, key: string): CacheEntry<T> {
    const cache = getRuntimeCache(runtime) as unknown as Map<string, CacheEntry<T>>
    const now = Date.now()

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

export function publish<T extends Entity>(entry: CacheEntry<T>, patch: Partial<RemoteState<T>>) {
    entry.lastAccessAt = Date.now()
    entry.state = { ...entry.state, ...patch }
    entry.subscribers.forEach((listener) => listener(entry.state))
}
