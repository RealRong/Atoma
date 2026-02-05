import { useMemo } from 'react'
import type * as Types from 'atoma-types/core'
import { getStoreBindings } from 'atoma-types/internal'
import { useRelations } from './useRelations'
import { useStoreQuery } from './useStoreQuery'
import { useRemoteQuery } from './useRemoteQuery'

type UseQueryResultMode = 'entities' | 'ids'

type UseQueryStatus = {
    loading: boolean
    isFetching: boolean
    isStale: boolean
    error?: Error
    pageInfo?: Types.PageInfo
}

type UseQueryEntitiesResult<
    T extends Types.Entity,
    Relations = {},
    Include extends Types.RelationIncludeInput<Relations> = {}
> = UseQueryStatus & {
    data: keyof Include extends never ? T[] : Types.WithRelations<T, Relations, Include>[]
    refetch: () => Promise<T[]>
    fetchMore: (options: Types.Query<T>) => Promise<T[]>
}

type UseQueryIdsResult<T extends Types.Entity> = UseQueryStatus & {
    data: Array<T['id']>
    refetch: () => Promise<Array<T['id']>>
    fetchMore: (options: Types.Query<T>) => Promise<Array<T['id']>>
}

type UseQueryOptions<T extends Types.Entity, Relations, Include extends Types.RelationIncludeInput<Relations>> =
    & Omit<Types.Query<T>, 'include'>
    & {
        include?: Types.RelationIncludeInput<Relations> & Include
        fetchPolicy?: Types.FetchPolicy
        result?: UseQueryResultMode
    }

const stripRuntimeOptions = (options?: any) => {
    if (!options) return undefined
    const { fetchPolicy: _fetchPolicy, result: _result, include: _include, ...rest } = options
    return rest
}

export function useQuery<T extends Types.Entity, Relations = {}, const Include extends Types.RelationIncludeInput<Relations> = {}>(
    store: Types.StoreApi<T, Relations>,
    options?: UseQueryOptions<T, Relations, Include> & { result?: 'entities' }
): UseQueryEntitiesResult<T, Relations, Include>

export function useQuery<T extends Types.Entity, Relations = {}>(
    store: Types.StoreApi<T, Relations>,
    options: UseQueryOptions<T, Relations, any> & { include?: never; result: 'ids' }
): UseQueryIdsResult<T>

export function useQuery<T extends Types.Entity, Relations = {}, const Include extends Types.RelationIncludeInput<Relations> = {}>(
    store: Types.StoreApi<T, Relations>,
    options?: UseQueryOptions<T, Relations, Include>
): UseQueryEntitiesResult<T, Relations, Include> | UseQueryIdsResult<T> {
    const fetchPolicy: Types.FetchPolicy = options?.fetchPolicy || 'cache-and-network'
    const resultMode: UseQueryResultMode = (options as any)?.result || 'entities'

    const wantsTransientRemote = Boolean(options?.select?.length)

    const optionsForStoreQuery = useMemo(() => stripRuntimeOptions(options) as Types.Query<T> | undefined, [options])

    const localEntities = useStoreQuery(store, optionsForStoreQuery
        ? { ...(optionsForStoreQuery as any), result: 'entities' as const }
        : ({ result: 'entities' as const } as any)
    )
    const localIds = useStoreQuery(store, optionsForStoreQuery
        ? { ...(optionsForStoreQuery as any), result: 'ids' as const }
        : ({ result: 'ids' as const } as any)
    )

    const remoteEnabled = fetchPolicy !== 'cache-only'
    const remoteBehavior = wantsTransientRemote ? ({ transient: true } as const) : ({ hydrate: true } as const)

    const optionsForRemote = useMemo(() => stripRuntimeOptions(options) as Types.Query<T> | undefined, [options])

    const remote = useRemoteQuery<T, Relations>({
        store,
        options: optionsForRemote,
        behavior: remoteBehavior,
        enabled: remoteEnabled
    })

    const data = (() => {
        if (resultMode === 'ids') {
            const remoteIds = remote.data !== undefined ? (remote.data ?? []).map(item => item.id) as Array<T['id']> : undefined
            if (remoteBehavior.transient && remoteIds !== undefined) return remoteIds
            return localIds
        }
        if (remoteBehavior.transient && remote.data !== undefined) return (remote.data ?? []) as T[]
        return localEntities
    })()

    const hasData = data.length > 0
    const isFetching = remoteEnabled ? remote.isFetching : false
    const loading = Boolean(remoteEnabled && isFetching && !hasData)
    const isStale = Boolean(fetchPolicy === 'cache-and-network' && hasData && isFetching)

    const pageInfo = remote.pageInfo
    const error = remote.error

    const refetch = () => {
        if (!remoteEnabled) {
            return Promise.resolve(data as any)
        }
        return remote.refetch().then(res => {
            if (resultMode === 'ids') return res.map(i => i.id) as any
            return res as any
        })
    }

    const fetchMore = (moreOptions: Types.Query<T>) => {
        if (!remoteEnabled) {
            return Promise.resolve([] as any)
        }
        return remote.fetchMore(moreOptions as any).then(res => {
            if (resultMode === 'ids') return res.map(i => i.id) as any
            return res as any
        })
    }

    if (resultMode === 'ids') {
        return {
            data: data as Array<T['id']>,
            loading,
            isFetching,
            isStale,
            error,
            pageInfo,
            refetch,
            fetchMore
        } satisfies UseQueryIdsResult<T>
    }

    const bindings = getStoreBindings(store, 'useQuery')
    const relations = bindings.relations?.() as Relations | undefined
    const effectiveInclude = (options as any)?.include ?? ({} as Include)

    const relationsResult = useRelations<T, Relations, Include>(
        data as unknown as T[],
        effectiveInclude,
        relations,
        (name) => bindings.ensureStore(name)
    )

    return {
        data: relationsResult.data as unknown as (keyof Include extends never ? T[] : Types.WithRelations<T, Relations, Include>[]),
        loading: loading || relationsResult.loading,
        isFetching,
        isStale,
        error: relationsResult.error ?? error,
        pageInfo,
        refetch,
        fetchMore
    } satisfies UseQueryEntitiesResult<T, Relations, Include>
}
