import type { Entity, PageInfo } from '@atoma-js/types/core'

export type RemoteState<T extends Entity> = Readonly<{
    isFetching: boolean
    error?: Error
    pageInfo?: PageInfo
    data?: T[]
}>

export type CacheEntry<T extends Entity> = {
    state: RemoteState<T>
    subscribers: Set<(state: RemoteState<T>) => void>
    inflightCount: number
    lastAccessAt: number
}

type TaskEntry = {
    promise: Promise<unknown> | null
    doneAt: number
    lastAccessAt: number
}

const REMOTE_QUERY_CACHE = new WeakMap<object, Map<string, CacheEntry<Entity>>>()
const FALLBACK_QUERY_CACHE = new Map<string, CacheEntry<Entity>>()
const REMOTE_CACHE_TTL_MS = 5 * 60 * 1000
const REMOTE_CACHE_MAX_ENTRIES = 200
const REMOTE_TASK_CACHE = new WeakMap<object, Map<string, TaskEntry>>()
const FALLBACK_TASK_CACHE = new Map<string, TaskEntry>()
const TASK_CACHE_TTL_MS = 5 * 60 * 1000
const TASK_CACHE_MAX_ENTRIES = 200

function shouldEvictEntry<T extends Entity>(entry: CacheEntry<T>, now: number): boolean {
    return entry.inflightCount === 0
        && entry.subscribers.size === 0
        && now - entry.lastAccessAt > REMOTE_CACHE_TTL_MS
}

function shouldEvictTaskEntry(entry: TaskEntry, now: number): boolean {
    if (entry.doneAt > 0) return now - entry.doneAt > TASK_CACHE_TTL_MS
    return !entry.promise && now - entry.lastAccessAt > TASK_CACHE_TTL_MS
}

function cleanupCache<T extends Entity>(cache: Map<string, CacheEntry<T>>, now: number) {
    const candidates: Array<[string, CacheEntry<T>]> = []
    cache.forEach((entry, key) => {
        if (shouldEvictEntry(entry, now)) {
            cache.delete(key)
            return
        }
        if (entry.inflightCount === 0 && entry.subscribers.size === 0) {
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

function cleanupTaskCache(cache: Map<string, TaskEntry>, now: number) {
    const candidates: Array<[string, TaskEntry]> = []
    cache.forEach((entry, key) => {
        if (shouldEvictTaskEntry(entry, now)) {
            cache.delete(key)
            return
        }
        if (entry.doneAt > 0 || !entry.promise) {
            candidates.push([key, entry])
        }
    })

    const overflow = cache.size - TASK_CACHE_MAX_ENTRIES
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

function getTaskCache(runtime?: object | null): Map<string, TaskEntry> {
    if (!runtime) return FALLBACK_TASK_CACHE
    const existing = REMOTE_TASK_CACHE.get(runtime)
    if (existing) return existing
    const next = new Map<string, TaskEntry>()
    REMOTE_TASK_CACHE.set(runtime, next)
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
        inflightCount: 0,
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

export function dedupeTask<Result>(args: {
    runtime?: object | null
    key: string
    task: () => Promise<Result>
    dedupeTtlMs?: number
}): Promise<Result> {
    const dedupeTtlMs = args.dedupeTtlMs ?? 300
    const now = Date.now()
    const cache = getTaskCache(args.runtime)
    cleanupTaskCache(cache, now)

    const existing = cache.get(args.key)
    if (existing?.promise) {
        existing.lastAccessAt = now
        if (existing.doneAt === 0 || now - existing.doneAt < dedupeTtlMs) {
            return existing.promise as Promise<Result>
        }
    }

    const entry: TaskEntry = existing ?? {
        promise: null,
        doneAt: 0,
        lastAccessAt: now
    }

    const promise = Promise.resolve().then(args.task)
    entry.promise = promise
    entry.doneAt = 0
    entry.lastAccessAt = now
    cache.set(args.key, entry)

    promise
        .then(() => {
            entry.promise = promise
            entry.doneAt = Date.now()
            entry.lastAccessAt = entry.doneAt
        })
        .catch(() => {
            entry.promise = null
            entry.doneAt = 0
            entry.lastAccessAt = Date.now()
        })

    return promise
}
