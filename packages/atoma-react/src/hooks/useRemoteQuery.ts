import { useCallback, useEffect, useMemo, useState } from 'react'
import { stableStringify } from 'atoma-shared'
import type { Entity, Store, PageInfo, Query } from 'atoma-types/core'
import { getStoreBindings } from 'atoma-types/internal'
import { getOrCreateEntry, publish, type RemoteState } from './internal/remoteQueryCache'

type UseRemoteQueryResult<T extends Entity> = RemoteState<T> & Readonly<{
    refetch: () => Promise<T[]>
    fetchMore: (options: Query<T>) => Promise<T[]>
}>

function normalizeResult<T extends Entity>(value: unknown): { data: T[]; pageInfo?: PageInfo } {
    if (!value || typeof value !== 'object') {
        return { data: [] }
    }
    const candidate = value as { data?: unknown; pageInfo?: PageInfo }
    return Array.isArray(candidate.data)
        ? { data: candidate.data as T[], pageInfo: candidate.pageInfo }
        : { data: [] }
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
