import { useMemo } from 'react'
import type {
    Entity,
    FindManyOptions,
    FetchPolicy,
    PageInfo,
    RelationIncludeInput,
    WithRelations,
    StoreApi
} from 'atoma/core'
import { useRelations } from './useRelations'
import { useStoreQuery } from './useStoreQuery'
import { useRemoteFindMany } from './useRemoteFindMany'
import { getStoreRelations } from './internal/storeInternal'

type UseFindManySelect = 'entities' | 'ids'

type UseFindManyStatus = {
    loading: boolean
    isFetching: boolean
    isStale: boolean
    error?: Error
    pageInfo?: PageInfo
}

type UseFindManyEntitiesResult<
    T extends Entity,
    Relations = {},
    Include extends RelationIncludeInput<Relations> = {}
> = UseFindManyStatus & {
    data: keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]
    refetch: () => Promise<T[]>
    fetchMore: (options: FindManyOptions<T>) => Promise<T[]>
}

type UseFindManyIdsResult<T extends Entity> = UseFindManyStatus & {
    data: Array<T['id']>
    refetch: () => Promise<Array<T['id']>>
    fetchMore: (options: FindManyOptions<T>) => Promise<Array<T['id']>>
}

const stripRuntimeOptions = (options?: any) => {
    if (!options) return undefined
    const { fetchPolicy: _fetchPolicy, select: _select, ...rest } = options
    return rest
}

export function useFindMany<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: StoreApi<T, Relations>,
    options?: FindManyOptions<T, RelationIncludeInput<Relations> & Include> & { fetchPolicy?: FetchPolicy; select?: 'entities' }
): UseFindManyEntitiesResult<T, Relations, Include>

export function useFindMany<T extends Entity, Relations = {}>(
    store: StoreApi<T, Relations>,
    options: Omit<FindManyOptions<T, any>, 'include'> & { include?: never; fetchPolicy?: FetchPolicy; select: 'ids' }
): UseFindManyIdsResult<T>

export function useFindMany<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: StoreApi<T, Relations>,
    options?: (FindManyOptions<T, RelationIncludeInput<Relations> & Include> & { fetchPolicy?: FetchPolicy; select?: UseFindManySelect })
): UseFindManyEntitiesResult<T, Relations, Include> | UseFindManyIdsResult<T> {
    const fetchPolicy: FetchPolicy = options?.fetchPolicy || 'cache-and-network'
    const select: UseFindManySelect = (options as any)?.select || 'entities'

    const baseFields = (options as any)?.fields
    const wantsTransientRemote = Boolean(options?.skipStore || baseFields?.length)

    const optionsForStoreQuery = useMemo(() => {
        const stripped = stripRuntimeOptions(options) as any
        if (!stripped) return undefined
        const { where, orderBy, limit, offset } = stripped
        return { where, orderBy, limit, offset } as any
    }, [options])

    const localEntities = useStoreQuery(store, optionsForStoreQuery)
    const localIds = useStoreQuery(store, { ...(optionsForStoreQuery as any), select: 'ids' as const })

    const remoteEnabled = fetchPolicy !== 'cache-only'
    const remoteBehavior = wantsTransientRemote ? ({ transient: true } as const) : ({ hydrate: true } as const)

    const optionsForRemote = useMemo(() => {
        const stripped = stripRuntimeOptions(options) as any
        if (!stripped) return undefined

        const effectiveSkipStore = Boolean(stripped?.skipStore || stripped?.fields?.length)
        return {
            ...stripped,
            // fields 存在时，强制 transient（不写入 store）
            skipStore: effectiveSkipStore
        } as any
    }, [options])

    const remote = useRemoteFindMany<T, Relations>({
        store,
        options: optionsForRemote,
        behavior: remoteBehavior,
        enabled: remoteEnabled
    })

    const data = (() => {
        if (select === 'ids') {
            if (fetchPolicy === 'network-only' && remoteBehavior.transient) {
                return (remote.data ?? []).map(item => item.id) as Array<T['id']>
            }
            return localIds
        }
        if (fetchPolicy === 'network-only' && remoteBehavior.transient) {
            return (remote.data ?? []) as T[]
        }
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
            if (select === 'ids') return res.map(i => i.id) as any
            return res as any
        })
    }

    const fetchMore = (moreOptions: FindManyOptions<T>) => {
        if (!remoteEnabled) {
            return Promise.resolve([] as any)
        }
        return remote.fetchMore(moreOptions as any).then(res => {
            if (select === 'ids') return res.map(i => i.id) as any
            return res as any
        })
    }

    if (select === 'ids') {
        return {
            data: data as Array<T['id']>,
            loading,
            isFetching,
            isStale,
            error,
            pageInfo,
            refetch,
            fetchMore
        } satisfies UseFindManyIdsResult<T>
    }

    const { relations, resolveStore } = getStoreRelations<T, Relations>(store, 'useFindMany')
    const effectiveInclude = (options as any)?.include ?? ({} as Include)

    const relationsResult = useRelations<T, Relations, Include>(
        data as unknown as T[],
        effectiveInclude,
        relations,
        resolveStore
    )

    return {
        data: relationsResult.data as unknown as (keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]),
        loading: loading || relationsResult.loading,
        isFetching,
        isStale,
        error: relationsResult.error ?? error,
        pageInfo,
        refetch,
        fetchMore
    } satisfies UseFindManyEntitiesResult<T, Relations, Include>
}
