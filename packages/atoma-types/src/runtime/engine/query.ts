import type { Entity, Query, QueryMatcherOptions, StoreIndexesLike } from '../../core'
import type { EntityId } from '../../shared'
import type { RuntimeCacheWriteDecision } from './shared'

export type RuntimeQuery = Readonly<{
    evaluate: <T extends Entity>(args: {
        mapRef: Map<EntityId, T>
        query: Query<T>
        indexes: StoreIndexesLike<T> | null
        matcher?: QueryMatcherOptions
    }) => { data: T[]; pageInfo?: unknown }
    cachePolicy: <T>(query?: Query<T>) => RuntimeCacheWriteDecision
}>
