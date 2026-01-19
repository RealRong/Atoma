import { useEffect, useMemo, useState } from 'react'
import type { Entity, FindManyOptions, PageInfo, StoreApi } from '#core'
import { storeHandleManager } from '../../core/store/internals/storeHandleManager'

type RemoteState<T extends Entity> = Readonly<{
    isFetching: boolean
    error?: Error
    pageInfo?: PageInfo
    data?: T[]
}>

type RemoteBehavior =
    | { hydrate: true; transient?: false }
    | { hydrate?: false; transient: true }

type UseRemoteFindManyResult<T extends Entity> = RemoteState<T> & Readonly<{
    refetch: () => Promise<T[]>
    fetchMore: (options: FindManyOptions<T>) => Promise<T[]>
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
    const { fetchPolicy: _fetchPolicy, select: _select, ...rest } = options
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

export function useRemoteFindMany<T extends Entity, Relations = {}>(args: {
    store: StoreApi<T, Relations>
    options?: FindManyOptions<T>
    behavior: RemoteBehavior
    enabled?: boolean
}): UseRemoteFindManyResult<T> {
    const enabled = args.enabled !== false
    const storeName = storeHandleManager.getStoreName(args.store, 'useRemoteFindMany')
    const runtime = storeHandleManager.getStoreRuntime(args.store)

    const key = useMemo(() => {
        const optionsKey = Core.query.stableStringify(stripRuntimeOptions(args.options))
        const modeKey = args.behavior.transient ? 'transient' : 'hydrate'
        return `${storeName}:${modeKey}:${optionsKey}`
    }, [storeName, args.behavior.transient, args.options])

    const entry = useMemo(() => getOrCreateEntry<T>(runtime, key), [runtime, key])
    const [state, setState] = useState<RemoteState<T>>(() => entry.state)

    useEffect(() => {
        const sub = (next: RemoteState<T>) => setState(next)
        entry.subscribers.add(sub)
        setState(entry.state)
        return () => {
            entry.subscribers.delete(sub)
        }
    }, [entry])

    const runFetch = async (options: FindManyOptions<T> | undefined, mode: 'refetch' | 'fetchMore'): Promise<T[]> => {
        if (!enabled) return []
        if (!args.store.findMany) {
            const err = new Error('findMany not implemented')
            publish(entry, { error: err, isFetching: false })
            throw err
        }

        if (entry.promise) return entry.promise

        publish(entry, {
            isFetching: true,
            ...(mode === 'refetch' ? { error: undefined } : {})
        })

        const transient = Boolean(args.behavior.transient)
        const effectiveOptions: any = stripRuntimeOptions(options) ?? {}
        if (transient) {
            effectiveOptions.skipStore = true
        }

        const p = args.store.findMany(effectiveOptions)
            .then(async (res: any) => {
                const { data, pageInfo } = normalizeResult<T>(res)
                if (!transient) {
                    await storeHandleManager.hydrateStore(args.store, data, 'useRemoteFindMany')
                }
                publish(entry, {
                    isFetching: false,
                    error: undefined,
                    pageInfo,
                    ...(transient
                        ? { data: mode === 'fetchMore' ? [...(entry.state.data ?? []), ...data] : data }
                        : {})
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
    const fetchMore = (moreOptions: FindManyOptions<T>) => runFetch(moreOptions, 'fetchMore')

    return {
        ...state,
        refetch,
        fetchMore
    }
}
