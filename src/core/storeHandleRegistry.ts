import type { Entity, IStore, StoreHandle } from './types'

const REGISTRY_KEY = Symbol.for('atoma.storeHandleRegistry')

function getGlobalRegistry(): WeakMap<IStore<any, any>, StoreHandle<any>> {
    const anyGlobal = globalThis as any
    const existing = anyGlobal[REGISTRY_KEY] as WeakMap<IStore<any, any>, StoreHandle<any>> | undefined
    if (existing) return existing
    const next = new WeakMap<IStore<any, any>, StoreHandle<any>>()
    anyGlobal[REGISTRY_KEY] = next
    return next
}

export const registerStoreHandle = <T extends Entity, Relations>(
    store: IStore<T, Relations>,
    handle: StoreHandle<T>
): void => {
    getGlobalRegistry().set(store, handle)
}

export const getStoreHandle = <T extends Entity, Relations>(
    store: IStore<T, Relations> | undefined
): StoreHandle<T> | null => {
    if (!store) return null
    return (getGlobalRegistry().get(store) as StoreHandle<T> | undefined) ?? null
}
