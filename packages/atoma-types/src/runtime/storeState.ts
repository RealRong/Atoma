import type { Entity, QueryMatcherOptions, StoreIndexesLike, StoreWritebackArgs } from '../core'
import type { EntityId } from '../shared'

export type StoreSnapshot<T extends Entity> = ReadonlyMap<EntityId, T>

export type StoreListener = () => void

export type StoreChangedIds = ReadonlyArray<EntityId> | ReadonlySet<EntityId>

export type StoreState<T extends Entity = any> = Readonly<{
    getSnapshot: () => StoreSnapshot<T>
    setSnapshot: (next: StoreSnapshot<T>) => void
    subscribe: (listener: StoreListener) => () => void
    indexes: StoreIndexesLike<T> | null
    matcher?: QueryMatcherOptions
    commit: (params: { before: Map<EntityId, T>; after: Map<EntityId, T>; changedIds?: StoreChangedIds }) => void
    applyWriteback: (args: StoreWritebackArgs<T>, options?: { preserve?: (existing: T, incoming: T) => T }) => void
}>
