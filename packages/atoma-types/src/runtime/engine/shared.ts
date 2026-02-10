import type { Entity, IndexesLike, Query } from '../../core'
import type { EntityId } from '../../shared'

export type RelationInclude = Record<string, boolean | Query<unknown>> | undefined

export type RelationPrefetchOptions = {
    onError?: 'skip' | 'throw' | 'partial'
    timeout?: number
    maxConcurrency?: number
}

export type StoreMap<T extends Entity = Entity> = {
    map: ReadonlyMap<EntityId, T>
    indexes: IndexesLike<T> | null
}
