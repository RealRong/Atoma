import type { Entity, IStore, StoreHandle } from './types'

const REGISTRY_KEY = Symbol.for('atoma.storeHandleRegistry')
const HANDLE_KEY = Symbol.for('atoma.storeHandle')

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

export const attachStoreHandle = <T extends Entity, Relations>(
    store: IStore<T, Relations>,
    handle: StoreHandle<T>
): void => {
    registerStoreHandle(store, handle)
    const anyStore: any = store as any
    if (anyStore && typeof anyStore === 'object') {
        anyStore[HANDLE_KEY] = handle
    }
}

export const getStoreHandle = <T extends Entity, Relations>(
    store: IStore<T, Relations> | undefined
): StoreHandle<T> | null => {
    if (!store) return null
    const fromRegistry = (getGlobalRegistry().get(store) as StoreHandle<T> | undefined)
    if (fromRegistry) return fromRegistry
    const anyStore: any = store as any
    const fromAttached = anyStore && typeof anyStore === 'object' ? (anyStore[HANDLE_KEY] as StoreHandle<T> | undefined) : undefined
    return fromAttached ?? null
}
