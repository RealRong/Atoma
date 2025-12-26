import type { PageInfo, FindManyOptions, RelationIncludeInput, RelationMap, WithRelations } from '#core'

export type UseFindManyResult<
    T,
    Relations = {},
    Include extends RelationIncludeInput<Relations> = {}
> = {
    data: keyof Include extends never
    ? T[]
    : WithRelations<T, Relations, Include>[]
    loading: boolean
    error?: Error
    refetch: () => Promise<T[]>
    isStale: boolean
    pageInfo?: PageInfo
    fetchMore: (options: FindManyOptions<T>) => Promise<T[]>
}
