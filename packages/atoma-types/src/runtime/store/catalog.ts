import type { Entity, Store, StoreToken } from '../../core'
import type { StoreHandle } from './handle'

export type StoreCatalog = Readonly<{
    ensure: (name: StoreToken) => Store<Entity>
    list: () => Iterable<Store<Entity>>
    ensureHandle: (name: StoreToken, tag?: string) => StoreHandle<Entity>
}>
