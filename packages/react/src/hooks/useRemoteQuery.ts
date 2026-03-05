import { useCallback, useEffect, useMemo, useState } from 'react'
import { stableStringify } from '@atoma-js/shared'
import type { Entity, Store, PageInfo, Query } from '@atoma-js/types/core'
import { getStoreBindings } from '@atoma-js/types/internal'
import { dedupeTask, getOrCreateEntry, publish, type RemoteState } from './internal/remoteQueryCache'

type UseRemoteQueryResult<T extends Entity> = RemoteState<T> & Readonly<{
    refetch: () => Promise<T[]>
    fetchMore: (options: Query<T>) => Promise<T[]>
}>

type FetchMode = 'refetch' | 'fetchMore'

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
    const { store, options, enabled: enabledInput } = args
    const enabled = enabledInput !== false
    const bindings = getStoreBindings(store, 'useRemoteQuery')
    const storeName = bindings.name
    const runtime = bindings.runtime as object
    const optionsKey = useMemo(() => stableStringify(options), [options])
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

    const runFetch = useCallback(async (query: Query<T> | undefined, mode: FetchMode): Promise<T[]> => {
        if (!enabled) return []

        const queryKey = stableStringify(query)
        return dedupeTask<T[]>({
            runtime,
            key: `${key}:${mode}:${queryKey}`,
            dedupeTtlMs: 0,
            task: async () => {
                entry.inflightCount += 1
                publish(entry, {
                    isFetching: true,
                    ...(mode === 'refetch' ? { error: undefined } : {})
                })
                try {
                    const result = await store.query(query ?? {})
                    const { data, pageInfo } = normalizeResult<T>(result)
                    publish(entry, {
                        error: undefined,
                        pageInfo,
                        data: mode === 'fetchMore'
                            ? [...(entry.state.data ?? []), ...data]
                            : data
                    })
                    return data
                } catch (error: unknown) {
                    const normalized = error instanceof Error ? error : new Error(String(error))
                    publish(entry, { error: normalized })
                    throw normalized
                } finally {
                    entry.inflightCount = Math.max(0, entry.inflightCount - 1)
                    publish(entry, { isFetching: entry.inflightCount > 0 })
                    entry.lastAccessAt = Date.now()
                }
            }
        })
    }, [enabled, entry, key, runtime, store])

    useEffect(() => {
        if (!enabled) return
        runFetch(options, 'refetch').catch(() => {
            // error already published
        })
    }, [enabled, optionsKey, runFetch])

    return {
        ...state,
        refetch: () => runFetch(options, 'refetch'),
        fetchMore: (options: Query<T>) => runFetch(options, 'fetchMore')
    }
}
