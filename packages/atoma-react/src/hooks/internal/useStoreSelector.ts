import { useRef, useSyncExternalStore } from 'react'
import type { Entity, StoreApi } from 'atoma/core'
import type { EntityId } from 'atoma/protocol'
import { getStoreSource } from 'atoma/internal'
import { requireStoreOwner } from './storeInternal'

type StoreSnapshot<T extends Entity> = ReadonlyMap<EntityId, T>

export function useStoreSnapshot<T extends Entity, Relations = {}>(
    store: StoreApi<T, Relations>,
    tag: string
): StoreSnapshot<T> {
    const { client, storeName } = requireStoreOwner(store, tag)
    const source = getStoreSource<T>(client, storeName)
    const getSnapshot = () => source.getSnapshot() as StoreSnapshot<T>
    const subscribe = (listener: () => void) => source.subscribe(listener)
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useStoreSelector<T extends Entity, Relations = {}, Selected = unknown>(
    store: StoreApi<T, Relations>,
    selector: (snapshot: StoreSnapshot<T>) => Selected,
    isEqual: (a: Selected, b: Selected) => boolean,
    tag: string
): Selected {
    const selectorRef = useRef(selector)
    const isEqualRef = useRef(isEqual)
    selectorRef.current = selector
    isEqualRef.current = isEqual

    const cacheRef = useRef<{ store: StoreApi<T, Relations>; snapshot: StoreSnapshot<T>; selection: Selected } | null>(null)

    const { client, storeName } = requireStoreOwner(store, tag)
    const source = getStoreSource<T>(client, storeName)

    const getSnapshot = () => {
        const snapshot = source.getSnapshot() as StoreSnapshot<T>
        const cached = cacheRef.current
        if (cached && cached.store === store && cached.snapshot === snapshot) {
            return cached.selection
        }

        const next = selectorRef.current(snapshot)
        if (cached && cached.store === store && isEqualRef.current(cached.selection, next)) {
            cacheRef.current = { store, snapshot, selection: cached.selection }
            return cached.selection
        }

        cacheRef.current = { store, snapshot, selection: next }
        return next
    }

    const subscribe = (listener: () => void) => source.subscribe(listener)
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
