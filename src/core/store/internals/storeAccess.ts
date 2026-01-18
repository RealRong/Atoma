import type { Entity, StoreApi, CoreRuntime } from '../../types'
import type { EntityId } from '#protocol'
import type { StoreIndexes } from '../../indexes/StoreIndexes'
import type { QueryMatcherOptions } from '../../query/QueryMatcher'
import type { StoreHandle } from './handleTypes'
import { getStoreHandle as getStoreHandleInternal, getStoreRuntime as getStoreRuntimeInternal } from './handleRegistry'

type StoreSnapshot<T extends Entity> = ReadonlyMap<EntityId, T>

const buildMissingHandleError = (tag: string) => {
    return new Error(`[Atoma] ${tag}: 未找到 storeHandle（atom/jotaiStore），请确认 store 已通过 createStore 创建`)
}

const resolveStoreHandle = <T extends Entity>(
    store: StoreApi<T, any> | undefined,
    tag?: string
): StoreHandle<T> | null => {
    const handle = getStoreHandleInternal(store)
    if (!handle && tag) {
        throw buildMissingHandleError(tag)
    }
    return handle ?? null
}

export const getStoreHandle = <T extends Entity>(
    store: StoreApi<T, any> | undefined
): StoreHandle<T> | null => {
    return resolveStoreHandle(store)
}

export const requireStoreHandle = <T extends Entity>(
    store: StoreApi<T, any>,
    tag: string
): StoreHandle<T> => {
    const handle = resolveStoreHandle(store, tag)
    if (!handle) throw buildMissingHandleError(tag)
    return handle
}

export const getStoreRuntime = <T extends Entity>(
    store: StoreApi<T, any> | undefined
): CoreRuntime | null => {
    return getStoreRuntimeInternal(store)
}

export const getStoreSnapshot = <T extends Entity>(
    store: StoreApi<T, any>,
    tag?: string
): StoreSnapshot<T> => {
    const handle = resolveStoreHandle(store, tag)
    if (!handle) return new Map<EntityId, T>()
    return handle.jotaiStore.get(handle.atom) as Map<EntityId, T>
}

export const subscribeStore = <T extends Entity>(
    store: StoreApi<T, any>,
    listener: () => void,
    tag?: string
): (() => void) => {
    const handle = resolveStoreHandle(store, tag)
    if (!handle) return () => {}
    if (typeof (handle.jotaiStore as any).sub !== 'function') return () => {}
    return handle.jotaiStore.sub(handle.atom, () => listener())
}

export const getStoreIndexes = <T extends Entity>(
    store: StoreApi<T, any>,
    tag?: string
): StoreIndexes<T> | null => {
    const handle = resolveStoreHandle(store, tag)
    return handle?.indexes ?? null
}

export const getStoreMatcher = <T extends Entity>(
    store: StoreApi<T, any> | undefined,
    tag?: string
): QueryMatcherOptions | undefined => {
    const handle = resolveStoreHandle(store, tag)
    return handle?.matcher
}

export const getStoreRelations = <T extends Entity>(
    store: StoreApi<T, any>,
    tag?: string
): any | undefined => {
    const handle = resolveStoreHandle(store, tag)
    return handle?.relations?.()
}

export const getStoreName = <T extends Entity>(
    store: StoreApi<T, any>,
    tag?: string
): string => {
    const handle = resolveStoreHandle(store, tag)
    return String(handle?.storeName || 'store')
}

export const hydrateStore = <T extends Entity>(
    store: StoreApi<T, any>,
    items: T[],
    tag?: string
): void => {
    if (!items.length) return
    const handle = resolveStoreHandle(store, tag)
    if (!handle) return

    const before = handle.jotaiStore.get(handle.atom) as Map<T['id'], T>
    const after = new Map(before)
    const changedIds = new Set<T['id']>()

    items.forEach(item => {
        const prev = before.get(item.id)
        after.set(item.id, item)
        if (prev !== item) changedIds.add(item.id)
    })

    if (!changedIds.size) return

    handle.jotaiStore.set(handle.atom, after)
    handle.indexes?.applyChangedIds(before, after, changedIds)
}
