import type { RelationMap, IStore, StoreAccess } from './types'

const registry = new WeakMap<IStore<any>, StoreAccess>()

export const registerStoreAccess = (store: IStore<any>, access: StoreAccess) => {
    registry.set(store, access)
}

export const resolveStoreAccess = (store: IStore<any> | undefined) => {
    if (!store) return null
    return registry.get(store) ?? null
}

export const resolveStoreMatcher = (store: IStore<any> | undefined) => {
    return resolveStoreAccess(store)?.matcher
}

export const resolveStoreRelations = <T>(store: IStore<any> | undefined): RelationMap<T> | undefined => {
    const getter = resolveStoreAccess(store)?.relations
    return getter ? (getter() as any) : undefined
}

export const resolveStoreName = (store: IStore<any> | undefined) => {
    const fromRegistry = resolveStoreAccess(store)?.storeName
    if (typeof fromRegistry === 'string' && fromRegistry) return fromRegistry
    return undefined
}
