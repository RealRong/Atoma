import type { Entity, Store, PageInfo, Query, RelationIncludeInput, WithRelations } from 'atoma-types/core'
import { useProjectedRelations } from './internal/useProjectedRelations'
import { useStoreQuery } from './useStoreQuery'
import { useRemoteQuery } from './useRemoteQuery'

type FetchPolicy = 'cache-only' | 'network-only' | 'cache-and-network'

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

type UseQueryOptions<Relations, Include extends RelationIncludeInput<Relations>> = Readonly<{
    include?: RelationIncludeInput<Relations> & Include
    fetchPolicy?: FetchPolicy
}>

export function useQuery<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: Store<T, Relations>,
    query?: Query<T>,
    options?: UseQueryOptions<Relations, Include>
): UseQueryResult<T, Relations, Include> {
    const fetchPolicy: FetchPolicy = options?.fetchPolicy ?? 'cache-and-network'

    const localData = useStoreQuery(store, query)
    const remoteEnabled = fetchPolicy !== 'cache-only'
    const remote = useRemoteQuery<T, Relations>({
        store,
        options: query,
        enabled: remoteEnabled
    })

    const hasData = localData.length > 0
    const isFetching = remoteEnabled ? remote.isFetching : false
    const remoteError = remoteEnabled ? remote.error : undefined
    const remotePageInfo = remoteEnabled ? remote.pageInfo : undefined
    const status: UseQueryStatus = {
        loading: remoteEnabled && isFetching && !hasData,
        isFetching,
        isStale: fetchPolicy === 'cache-and-network' && hasData && isFetching,
        error: remoteError,
        pageInfo: remotePageInfo
    }

    const refetch = () => remoteEnabled ? remote.refetch() : Promise.resolve(localData)

    const fetchMore = (moreOptions: Query<T>) => remoteEnabled ? remote.fetchMore(moreOptions) : Promise.resolve([])

    const relationResult = useProjectedRelations<T, Relations, Include>({
        store,
        items: localData,
        include: options?.include,
        tag: 'useQuery'
    })

    const baseResult: UseQueryResult<T, Relations, Include> = {
        ...status,
        data: localData as keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[],
        refetch,
        fetchMore
    }

    return {
        ...baseResult,
        loading: baseResult.loading || relationResult.loading,
        error: relationResult.error ?? baseResult.error,
        data: relationResult.data as keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[],
    }
}
