import type * as Types from '../core'
import type { EntityId } from '../protocol'

export type StoreSnapshot<T extends Types.Entity> = ReadonlyMap<EntityId, T>

export type StoreListener = () => void

export type StoreState<T extends Types.Entity = any> = Readonly<{
    getSnapshot: () => StoreSnapshot<T>
    setSnapshot: (next: StoreSnapshot<T>) => void
    subscribe: (listener: StoreListener) => () => void
}>
