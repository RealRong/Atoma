import type { Entity, IndexesLike, StoreChange, StoreDelta, StoreWritebackEntry } from '../../core'
import type { EntityId } from '../../shared'

export type StoreState<T extends Entity = Entity> = Readonly<{
    snapshot: () => ReadonlyMap<EntityId, T>
    subscribe: (listener: () => void) => () => void
    indexes: IndexesLike<T> | null
    apply: (changes: ReadonlyArray<StoreChange<T>>) => StoreDelta<T> | null
    writeback: (entries: ReadonlyArray<StoreWritebackEntry<T>>) => StoreDelta<T> | null
}>
