import type { Entity, IndexesLike, Query } from '../../core'
import type { EntityId } from '../../shared'

export type RuntimeRelationInclude = Record<string, boolean | Query<unknown>> | undefined

export type RuntimeRelationPrefetchOptions = {
    onError?: 'skip' | 'throw' | 'partial'
    timeout?: number
    maxConcurrency?: number
}

export type RuntimeStoreMap<T extends Entity = Entity> = {
    map: ReadonlyMap<EntityId, T>
    indexes: IndexesLike<T> | null
}
