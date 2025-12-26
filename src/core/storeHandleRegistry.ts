import type { Entity, IStore, StoreHandle } from './types'

const registry = new WeakMap<IStore<any>, StoreHandle<any>>()

export const registerStoreHandle = <T extends Entity>(store: IStore<T>, handle: StoreHandle<T>) => {
    registry.set(store as any, handle as any)
}

export const getStoreHandle = <T extends Entity>(store: IStore<T> | undefined): StoreHandle<T> | null => {
    if (!store) return null
    return (registry.get(store) as StoreHandle<T> | undefined) ?? null
}
