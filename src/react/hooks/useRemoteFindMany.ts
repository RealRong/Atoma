import { useEffect, useMemo, useState } from 'react'
import { Core } from '#core'
import type { Entity, FindManyOptions, PageInfo, StoreHandleOwner } from '#core'

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

const REMOTE_QUERY_CACHE = new Map<string, CacheEntry<any>>()

function stripRuntimeOptions(options?: any) {
    if (!options) return undefined
    const { fetchPolicy: _fetchPolicy, select: _select, ...rest } = options
    return rest
}

function normalizeResult<T extends Entity>(res: any): { data: T[]; pageInfo?: PageInfo } {
    if (res && Array.isArray(res.data)) return { data: res.data, pageInfo: res.pageInfo }
    return { data: [] }
}

function getOrCreateEntry<T extends Entity>(key: string): CacheEntry<T> {
    const existing = REMOTE_QUERY_CACHE.get(key)
    if (existing) return existing
    const next: CacheEntry<T> = {
        state: { isFetching: false, error: undefined, pageInfo: undefined, data: undefined },
        subscribers: new Set(),
        promise: null
    }
    REMOTE_QUERY_CACHE.set(key, next)
    return next
}

function publish<T extends Entity>(entry: CacheEntry<T>, patch: Partial<RemoteState<T>>) {
    entry.state = { ...entry.state, ...patch }
    entry.subscribers.forEach(fn => fn(entry.state))
}

function hydrateIntoStore<T extends Entity>(store: StoreHandleOwner<T, any>, items: T[]) {
    if (!items.length) return
    const handle = Core.store.getHandle(store)
    if (!handle) return

    const before = handle.jotaiStore.get(handle.atom) as Map<T['id'], T>
    const after = new Map(before)
    const changedIds = new Set<T['id']>()

    items.forEach(item => {
        const prev = before.get(item.id)
        after.set(item.id, item)
        if (prev !== item) changedIds.add(item.id)
    })

    if (!changedIds.size) return

    handle.jotaiStore.set(handle.atom, after)
    handle.indexes?.applyChangedIds(before, after, changedIds)
}

export function useRemoteFindMany<T extends Entity, Relations = {}>(args: {
    store: StoreHandleOwner<T, Relations>
    options?: FindManyOptions<T>
    behavior: RemoteBehavior
    enabled?: boolean
}): UseRemoteFindManyResult<T> {
    const enabled = args.enabled !== false
    const handle = Core.store.getHandle(args.store)
    if (!handle) {
        throw new Error('[Atoma] useRemoteFindMany: 未找到 storeHandle（atom/jotaiStore），请确认 store 已通过 createStore 创建')
    }

    const key = useMemo(() => {
        const optionsKey = Core.query.stableStringify(stripRuntimeOptions(args.options))
        const modeKey = args.behavior.transient ? 'transient' : 'hydrate'
        return `${handle.backend.key}:${handle.storeName}:${modeKey}:${optionsKey}`
    }, [handle.backend.key, handle.storeName, args.behavior.transient, args.options])

    const entry = useMemo(() => getOrCreateEntry<T>(key), [key])
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
            .then((res: any) => {
                const { data, pageInfo } = normalizeResult<T>(res)
                if (!transient) {
                    hydrateIntoStore(args.store, data)
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
