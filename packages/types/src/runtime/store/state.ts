import type { Entity, Indexes, StoreChange } from '../../core'
import type { EntityId } from '../../shared'

export type StoreState<T extends Entity = Entity> = Readonly<{
    snapshot: () => ReadonlyMap<EntityId, T>
    subscribe: (listener: () => void) => () => void
    indexes: Indexes<T> | null
    apply: (changes: ReadonlyArray<StoreChange<T>>) => ReadonlyArray<StoreChange<T>>
    upsert: (items: ReadonlyArray<T>) => ReadonlyArray<StoreChange<T>>
    replace: (items: ReadonlyArray<T>) => ReadonlyArray<StoreChange<T>>
}>
