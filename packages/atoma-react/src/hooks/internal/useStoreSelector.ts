import { useRef, useSyncExternalStore } from 'react'
import type { Entity, StoreApi } from 'atoma/core'
import type { EntityId } from 'atoma/protocol'
import { unstable_storeHandleManager as storeHandleManager } from 'atoma/core'

type StoreSnapshot<T extends Entity> = ReadonlyMap<EntityId, T>

export function useStoreSnapshot<T extends Entity, Relations = {}>(
    store: StoreApi<T, Relations>,
    tag: string
): StoreSnapshot<T> {
    const getSnapshot = () => storeHandleManager.getStoreSnapshot(store, tag) as StoreSnapshot<T>
    const subscribe = (listener: () => void) => storeHandleManager.subscribeStore(store, listener, tag)
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

    const getSnapshot = () => {
        const snapshot = storeHandleManager.getStoreSnapshot(store, tag) as StoreSnapshot<T>
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

    const subscribe = (listener: () => void) => storeHandleManager.subscribeStore(store, listener, tag)
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
