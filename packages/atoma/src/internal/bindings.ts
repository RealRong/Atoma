import type * as Types from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { AtomaClient } from 'atoma-types/client'
import { requireClientRuntime } from 'atoma-client'

export type StoreSource<T extends Types.Entity> = Readonly<{
    getSnapshot: () => ReadonlyMap<EntityId, T>
    subscribe: (listener: () => void) => () => void
}>

type RuntimeLike = {
    stores: {
        ensure: (name: Types.StoreToken) => Types.StoreApi<any, any>
        resolveHandle: (name: Types.StoreToken, tag?: string) => any
    }
    transform: { writeback: (handle: any, item: any) => Promise<any> }
}

const toStoreName = (name: unknown) => String(name)

function ensureHandle(client: AtomaClient<any, any>, storeName: Types.StoreToken, tag: string) {
    const runtime = requireClientRuntime(client, tag) as RuntimeLike
    const name = toStoreName(storeName)
    const handle = runtime.stores.resolveHandle(name, tag)
    return { runtime, handle, name }
}

export function resolveStore(client: AtomaClient<any, any>, name: Types.StoreToken): Types.StoreApi<any, any> {
    const runtime = requireClientRuntime(client, 'resolveStore') as RuntimeLike
    return runtime.stores.ensure(String(name))
}

export function getStoreSource<T extends Types.Entity>(client: AtomaClient<any, any>, storeName: Types.StoreToken): StoreSource<T> {
    const { handle } = ensureHandle(client, storeName, 'getStoreSource')

    const getSnapshot = () => handle.jotaiStore.get(handle.atom) as ReadonlyMap<EntityId, T>
    const subscribe = (listener: () => void) => {
        const s: any = handle.jotaiStore
        if (typeof s?.sub !== 'function') return () => {}
        return s.sub(handle.atom, () => listener())
    }

    return { getSnapshot, subscribe }
}

export function getStoreSnapshotMap<T extends Types.Entity>(client: AtomaClient<any, any>, storeName: Types.StoreToken): ReadonlyMap<EntityId, T> {
    return getStoreSource<T>(client, storeName).getSnapshot()
}

export function getStoreIndexes(client: AtomaClient<any, any>, storeName: Types.StoreToken): any {
    return ensureHandle(client, storeName, 'getStoreIndexes').handle.indexes
}

export function getStoreMatcher(client: AtomaClient<any, any>, storeName: Types.StoreToken): any | undefined {
    return ensureHandle(client, storeName, 'getStoreMatcher').handle.matcher
}

export function getStoreRelations(client: AtomaClient<any, any>, storeName: Types.StoreToken): any | undefined {
    return ensureHandle(client, storeName, 'getStoreRelations').handle.relations?.()
}

export async function hydrateStore<T extends Types.Entity>(client: AtomaClient<any, any>, storeName: Types.StoreToken, items: T[]): Promise<void> {
    if (!items.length) return
    const { runtime, handle } = ensureHandle(client, storeName, 'hydrateStore')

    const processed = (await Promise.all(items.map(async (item) => runtime.transform.writeback(handle, item))))
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
