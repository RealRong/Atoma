import type { Entity, StoreApi, StoreToken } from 'atoma/core'
import type { EntityId } from 'atoma/protocol'

const STORE_INTERNAL = Symbol.for('atoma.storeInternal')

type StoreHandleLike = Readonly<{
    atom: any
    jotaiStore: any
    matcher?: any
    indexes: any
    relations?: () => any | undefined
}>

type StoreInternal = Readonly<{
    storeName: string
    resolveStore: (name: StoreToken) => StoreApi<any, any>
    getHandle: () => StoreHandleLike
    writeback: (handle: any, item: any) => Promise<any>
}>

export type StoreSource<T extends Entity> = Readonly<{
    getSnapshot: () => ReadonlyMap<EntityId, T>
    subscribe: (listener: () => void) => () => void
}>

export function requireStoreInternal<T extends Entity, Relations>(
    store: StoreApi<T, Relations>,
    tag: string
): StoreInternal {
    const anyStore: any = store as any
    const internal = anyStore && typeof anyStore === 'object' ? (anyStore[STORE_INTERNAL] as StoreInternal | undefined) : undefined
    if (!internal) {
        throw new Error(`[Atoma] ${tag}: store 缺少内部通道（请使用 client.stores.* 获取 store）`)
    }
    return internal
}

export function getStoreSource<T extends Entity, Relations>(
    store: StoreApi<T, Relations>,
    tag: string
): StoreSource<T> {
    const internal = requireStoreInternal(store, tag)
    const handle = internal.getHandle()

    const getSnapshot = () => handle.jotaiStore.get(handle.atom) as ReadonlyMap<EntityId, T>
    const subscribe = (listener: () => void) => {
        const s: any = handle.jotaiStore
        if (typeof s?.sub !== 'function') return () => {}
        return s.sub(handle.atom, () => listener())
    }

    return { getSnapshot, subscribe }
}

export function getStoreMatcher<T extends Entity, Relations>(
    store: StoreApi<T, Relations>
): any | undefined {
    try {
        const internal = requireStoreInternal(store, 'getStoreMatcher')
        return internal.getHandle().matcher
    } catch {
        return undefined
    }
}

export function getStoreRelations<T extends Entity, Relations>(
    store: StoreApi<T, Relations>,
    tag: string
): { relations?: Relations; resolveStore?: (name: StoreToken) => StoreApi<any, any> } {
    const internal = requireStoreInternal(store, tag)
    const handle = internal.getHandle()
    return {
        relations: handle.relations?.() as Relations | undefined,
        resolveStore: internal.resolveStore
    }
}

export async function hydrateStore<T extends Entity, Relations>(
    store: StoreApi<T, Relations>,
    items: T[],
    tag: string
): Promise<void> {
    if (!items.length) return
    const internal = requireStoreInternal(store, tag)
    const handle = internal.getHandle() as any

    const processed = (await Promise.all(items.map(async (item) => internal.writeback(handle, item))))
        .filter(Boolean) as T[]

    if (!processed.length) return

    const before = handle.jotaiStore.get(handle.atom) as Map<T['id'], T>
    const after = new Map(before)
    const changedIds = new Set<T['id']>()

    processed.forEach(item => {
        const prev = before.get(item.id)
        after.set(item.id, item)
        if (prev !== item) changedIds.add(item.id)
    })

    if (!changedIds.size) return

    handle.jotaiStore.set(handle.atom, after)
    handle.indexes?.applyChangedIds(before, after, changedIds)
}
