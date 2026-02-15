import type { Entity, IndexesLike, StoreWritebackArgs } from '../core'
import type { EntityId } from '../shared'

export type StoreSnapshot<T extends Entity> = ReadonlyMap<EntityId, T>

export type StoreListener = () => void

export type StoreState<T extends Entity = Entity> = Readonly<{
    getSnapshot: () => StoreSnapshot<T>
    setSnapshot: (next: StoreSnapshot<T>) => void
    subscribe: (listener: StoreListener) => () => void
    indexes: IndexesLike<T> | null
    commit: (params: {
        before: Map<EntityId, T>
        after: Map<EntityId, T>
        changedIds?: ReadonlySet<EntityId>
    }) => void
    applyWriteback: (args: StoreWritebackArgs<T>) => void
}>
