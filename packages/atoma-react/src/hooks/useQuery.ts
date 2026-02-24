import { useMemo } from 'react'
import type { Entity, Store, PageInfo, Query, RelationIncludeInput, WithRelations } from 'atoma-types/core'
import { getStoreBindings } from 'atoma-types/internal'
import { useRelations } from './useRelations'
import { useStoreQuery, useStoreQueryIds } from './useStoreQuery'
import { useRemoteQuery } from './useRemoteQuery'
import { evaluateFetchPolicyRuntime, resolveRemoteEnabled, type FetchPolicy } from './internal/fetchPolicy'

type UseQueryStatus = Readonly<{
    loading: boolean
    isFetching: boolean
    isStale: boolean
    error?: Error
    pageInfo?: PageInfo
}>

export type UseQueryResult<
    T extends Entity,
    Relations = {},
    Include extends RelationIncludeInput<Relations> = {}
> = UseQueryStatus & Readonly<{
    data: keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]
    refetch: () => Promise<T[]>
    fetchMore: (options: Query<T>) => Promise<T[]>
}>

export type UseQueryIdsResult<T extends Entity> = UseQueryStatus & Readonly<{
    data: Array<T['id']>
    refetch: () => Promise<Array<T['id']>>
    fetchMore: (options: Query<T>) => Promise<Array<T['id']>>
}>

type UseQueryOptions<T extends Entity, Relations, Include extends RelationIncludeInput<Relations>> =
    & Query<T>
    & {
        include?: RelationIncludeInput<Relations> & Include
        fetchPolicy?: FetchPolicy
    }

type UseQueryIdsOptions<T extends Entity> =
    & Query<T>
    & {
        fetchPolicy?: FetchPolicy
    }

function stripQueryOptions<T extends Entity, Relations, Include extends RelationIncludeInput<Relations>>(
    options?: UseQueryOptions<T, Relations, Include>
): Query<T> | undefined {
    if (!options) return undefined
    const { fetchPolicy: _fetchPolicy, include: _include, ...query } = options
    return query
}

function buildStatus(args: {
    fetchPolicy: FetchPolicy
    hasData: boolean
    isFetching: boolean
    error?: Error
    pageInfo?: PageInfo
}): UseQueryStatus {
    const { loading, isStale } = evaluateFetchPolicyRuntime({
        fetchPolicy: args.fetchPolicy,
        hasData: args.hasData,
        isFetching: args.isFetching
    })
    return {
        loading,
        isFetching: args.isFetching,
        isStale,
        error: args.error,
        pageInfo: args.pageInfo
    }
}

export function useQuery<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: Store<T, Relations>,
    options?: UseQueryOptions<T, Relations, Include>
): UseQueryResult<T, Relations, Include> {
    const fetchPolicy: FetchPolicy = options?.fetchPolicy ?? 'cache-and-network'
    const query = useMemo(() => stripQueryOptions(options), [options])

    const localData = useStoreQuery(store, query)
    const remoteEnabled = resolveRemoteEnabled(fetchPolicy)
    const remote = useRemoteQuery<T, Relations>({
        store,
        options: query,
        enabled: remoteEnabled
    })

    const status = buildStatus({
        fetchPolicy,
        hasData: localData.length > 0,
        isFetching: remoteEnabled ? remote.isFetching : false,
        error: remote.error,
        pageInfo: remote.pageInfo
    })

    const refetch = () => {
        if (!remoteEnabled) {
            return Promise.resolve(localData)
        }
        return remote.refetch()
    }

    const fetchMore = (moreOptions: Query<T>) => {
        if (!remoteEnabled) {
            return Promise.resolve([])
        }
        return remote.fetchMore(moreOptions)
    }

    const bindings = getStoreBindings(store, 'useQuery')
    const relations = bindings.relations?.()
    const include = options?.include
    if (!include || !relations) {
        return {
            ...status,
            data: localData as keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[],
            refetch,
            fetchMore
        }
    }

    const relationResult = useRelations<T, Relations, Include>(
        localData,
        include,
        relations,
        bindings.useStore
    )

    return {
        ...status,
        loading: status.loading || relationResult.loading,
        error: relationResult.error ?? status.error,
        data: relationResult.data as keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[],
        refetch,
        fetchMore
    }
}

export function useQueryIds<T extends Entity, Relations = {}>(
    store: Store<T, Relations>,
    options?: UseQueryIdsOptions<T>
): UseQueryIdsResult<T> {
    const fetchPolicy: FetchPolicy = options?.fetchPolicy ?? 'cache-and-network'
    const query = useMemo(() => {
        if (!options) return undefined
        const { fetchPolicy: _fetchPolicy, ...rest } = options
        return rest as Query<T>
    }, [options])

    const localData = useStoreQueryIds(store, query)
    const remoteEnabled = resolveRemoteEnabled(fetchPolicy)
    const remote = useRemoteQuery<T, Relations>({
        store,
        options: query,
        enabled: remoteEnabled
    })

    const status = buildStatus({
        fetchPolicy,
        hasData: localData.length > 0,
        isFetching: remoteEnabled ? remote.isFetching : false,
        error: remote.error,
        pageInfo: remote.pageInfo
    })

    const refetch = async () => {
        if (!remoteEnabled) {
            return localData
        }
        return (await remote.refetch()).map((item) => item.id)
    }

    const fetchMore = async (moreOptions: Query<T>) => {
        if (!remoteEnabled) {
            return []
        }
        return (await remote.fetchMore(moreOptions)).map((item) => item.id)
    }

    return {
        ...status,
        data: localData,
        refetch,
        fetchMore
    }
}
