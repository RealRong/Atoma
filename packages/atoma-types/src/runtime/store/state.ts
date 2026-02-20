import type { Entity, IndexesLike, StoreChange, StoreDelta, StoreWritebackArgs } from '../../core'
import type { EntityId } from '../../shared'

export type StoreSnapshot<T extends Entity> = ReadonlyMap<EntityId, T>

export type StoreListener = () => void

export type StoreState<T extends Entity = Entity> = Readonly<{
    snapshot: () => StoreSnapshot<T>
    subscribe: (listener: StoreListener) => () => void
    indexes: IndexesLike<T> | null
    apply: (changes: ReadonlyArray<StoreChange<T>>) => StoreDelta<T> | null
    writeback: (args: StoreWritebackArgs<T>) => StoreDelta<T> | null
}>
