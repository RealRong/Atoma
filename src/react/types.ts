import type { PageInfo, FindManyOptions, RelationMap, WithRelations } from '../core/types'

export type UseFindManyResult<
    T,
    Relations extends RelationMap<T> = {},
    Include extends Partial<Record<keyof Relations, any>> = {}
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
