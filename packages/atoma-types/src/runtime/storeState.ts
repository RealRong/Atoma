import type * as Types from '../core'
import type { EntityId } from '../protocol'

export type StoreSnapshot<T extends Types.Entity> = ReadonlyMap<EntityId, T>

export type StoreListener = () => void

export type StoreChangedIds = ReadonlyArray<EntityId> | ReadonlySet<EntityId>

export type StoreState<T extends Types.Entity = any> = Readonly<{
    getSnapshot: () => StoreSnapshot<T>
    setSnapshot: (next: StoreSnapshot<T>) => void
    subscribe: (listener: StoreListener) => () => void
    commit: (params: { before: Map<EntityId, T>; after: Map<EntityId, T>; changedIds?: StoreChangedIds }) => void
    applyWriteback: (args: Types.StoreWritebackArgs<T>, options?: { preserve?: (existing: T, incoming: T) => T }) => void
}>
