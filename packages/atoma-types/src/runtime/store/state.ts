import type { Entity, IndexesLike, StoreChange, StoreDelta, StoreWritebackArgs } from '../../core'
import type { EntityId } from '../../shared'

export type StoreState<T extends Entity = Entity> = Readonly<{
    snapshot: () => ReadonlyMap<EntityId, T>
    subscribe: (listener: () => void) => () => void
    indexes: IndexesLike<T> | null
    apply: (changes: ReadonlyArray<StoreChange<T>>) => StoreDelta<T> | null
    writeback: (args: StoreWritebackArgs<T>) => StoreDelta<T> | null
}>
