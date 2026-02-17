import type { Entity, Query, QueryResult, RelationMap, StoreToken } from '../../core'
import type { EntityId } from '../../shared'
import type { RelationInclude, RelationPrefetchOptions, StoreMap } from './shared'

export type RelationStore = Readonly<{
    getMany: (ids: EntityId[], cache?: boolean) => Promise<unknown[]>
    query?: (query: Query<unknown>) => Promise<QueryResult<unknown>>
}>

export type RelationEngine = Readonly<{
    project: <T extends Entity>(
        items: T[],
        include: RelationInclude,
        relations: RelationMap<T> | undefined,
        storeStates: ReadonlyMap<StoreToken, StoreMap>
    ) => T[]
    prefetch: <T extends Entity>(
        items: T[],
        include: RelationInclude,
        relations: RelationMap<T> | undefined,
        resolveStore: (name: StoreToken) => RelationStore | undefined,
        options?: RelationPrefetchOptions
    ) => Promise<void>
}>
