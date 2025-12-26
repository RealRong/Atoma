import type { Entity, IStore, StoreHandle } from './types'

const registry = new WeakMap<IStore<any, any>, StoreHandle<any>>()

export const registerStoreHandle = <T extends Entity, Relations>(
    store: IStore<T, Relations>,
    handle: StoreHandle<T>
): void => {
    registry.set(store, handle)
}

export const getStoreHandle = <T extends Entity, Relations>(
    store: IStore<T, Relations> | undefined
): StoreHandle<T> | null => {
    if (!store) return null
    return (registry.get(store) as StoreHandle<T> | undefined) ?? null
}
