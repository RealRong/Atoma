import type { Entity, Indexes, RelationIncludeInput } from '../../core'
import type { EntityId } from '../../shared'

export type RelationInclude = RelationIncludeInput<Record<string, unknown>> | undefined

export type RelationPrefetchOptions = {
    onError?: 'skip' | 'throw' | 'partial'
    timeout?: number
    maxConcurrency?: number
}

export type StoreMap<T extends Entity = Entity> = {
    map: ReadonlyMap<EntityId, T>
    indexes: Indexes<T> | null
}
