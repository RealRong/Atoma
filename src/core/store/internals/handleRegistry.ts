import type { CoreRuntime, Entity, StoreApi } from '../../types'
import type { StoreHandle } from './handleTypes'

const REGISTRY_KEY = Symbol.for('atoma.storeHandleRegistry')
const HANDLE_KEY = Symbol.for('atoma.storeHandle')
const RUNTIME_REGISTRY_KEY = Symbol.for('atoma.storeRuntimeRegistry')
const RUNTIME_KEY = Symbol.for('atoma.storeRuntime')

function getGlobalRegistry(): WeakMap<object, StoreHandle<any>> {
    const anyGlobal = globalThis as any
    const existing = anyGlobal[REGISTRY_KEY] as WeakMap<object, StoreHandle<any>> | undefined
    if (existing) return existing
    const next = new WeakMap<object, StoreHandle<any>>()
    anyGlobal[REGISTRY_KEY] = next
    return next
}

function getGlobalRuntimeRegistry(): WeakMap<object, CoreRuntime> {
    const anyGlobal = globalThis as any
    const existing = anyGlobal[RUNTIME_REGISTRY_KEY] as WeakMap<object, CoreRuntime> | undefined
    if (existing) return existing
    const next = new WeakMap<object, CoreRuntime>()
    anyGlobal[RUNTIME_REGISTRY_KEY] = next
    return next
}

export const registerStoreHandle = <T extends Entity, Relations>(
    store: StoreApi<T, Relations>,
    handle: StoreHandle<T>
): void => {
    getGlobalRegistry().set(store, handle)
}

export const attachStoreHandle = <T extends Entity, Relations>(
    store: StoreApi<T, Relations>,
    handle: StoreHandle<T>
): void => {
    registerStoreHandle(store, handle)
    const anyStore: any = store as any
    if (anyStore && typeof anyStore === 'object') {
        anyStore[HANDLE_KEY] = handle
    }
}

export const registerStoreRuntime = <T extends Entity, Relations>(
    store: StoreApi<T, Relations>,
    runtime: CoreRuntime
): void => {
    getGlobalRuntimeRegistry().set(store, runtime)
}

export const attachStoreRuntime = <T extends Entity, Relations>(
    store: StoreApi<T, Relations>,
    runtime: CoreRuntime
): void => {
    registerStoreRuntime(store, runtime)
    const anyStore: any = store as any
    if (anyStore && typeof anyStore === 'object') {
        anyStore[RUNTIME_KEY] = runtime
    }
}

export const getStoreRuntime = <T extends Entity, Relations>(
    store: StoreApi<T, Relations> | undefined
): CoreRuntime | null => {
    if (!store) return null
    const fromRegistry = (getGlobalRuntimeRegistry().get(store) as CoreRuntime | undefined)
    if (fromRegistry) return fromRegistry
    const anyStore: any = store as any
    const fromAttached = anyStore && typeof anyStore === 'object' ? (anyStore[RUNTIME_KEY] as CoreRuntime | undefined) : undefined
    return fromAttached ?? null
}

export const getStoreHandle = <T extends Entity, Relations>(
    store: StoreApi<T, Relations> | undefined
): StoreHandle<T> | null => {
    if (!store) return null
    const fromRegistry = (getGlobalRegistry().get(store) as StoreHandle<T> | undefined)
    if (fromRegistry) return fromRegistry
    const anyStore: any = store as any
    const fromAttached = anyStore && typeof anyStore === 'object' ? (anyStore[HANDLE_KEY] as StoreHandle<T> | undefined) : undefined
    return fromAttached ?? null
}
