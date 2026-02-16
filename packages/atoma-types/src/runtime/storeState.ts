import type { Patch } from 'immer'
import type { Entity, IndexesLike, StoreDelta, StoreWritebackArgs } from '../core'
import type { EntityId } from '../shared'

export type StoreSnapshot<T extends Entity> = ReadonlyMap<EntityId, T>

export type StoreListener = () => void

export type StoreState<T extends Entity = Entity> = Readonly<{
    getSnapshot: () => StoreSnapshot<T>
    subscribe: (listener: StoreListener) => () => void
    indexes: IndexesLike<T> | null
    mutate: (recipe: (draft: Map<EntityId, T>) => void) => StoreDelta<T> | null
    applyWriteback: (args: StoreWritebackArgs<T>) => StoreDelta<T> | null
    applyPatches: (patches: Patch[]) => StoreDelta<T> | null
}>
