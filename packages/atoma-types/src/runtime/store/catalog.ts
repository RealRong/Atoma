import type { Entity, Store, StoreToken } from '../core'
import type { StoreHandle } from './handle'

export type StoreCatalog = Readonly<{
    resolve: (name: StoreToken) => Store<Entity> | undefined
    ensure: (name: StoreToken) => Store<Entity>
    list: () => Iterable<Store<Entity>>
    onCreated: (listener: (store: Store<Entity>) => void, options?: { replay?: boolean }) => () => void
    ensureHandle: (name: StoreToken, tag?: string) => StoreHandle<Entity>
}>
