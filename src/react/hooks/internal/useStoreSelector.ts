import { useRef, useSyncExternalStore } from 'react'
import type { Entity, StoreHandleOwner } from '#core'
import type { EntityId } from '#protocol'
import { getStoreSnapshot, subscribeStore } from '../../../core/store/internals/storeAccess'

type StoreSnapshot<T extends Entity> = ReadonlyMap<EntityId, T>

export function useStoreSnapshot<T extends Entity, Relations = {}>(
    store: StoreHandleOwner<T, Relations>,
    tag: string
): StoreSnapshot<T> {
    const getSnapshot = () => getStoreSnapshot(store, tag) as StoreSnapshot<T>
    const subscribe = (listener: () => void) => subscribeStore(store, listener, tag)
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useStoreSelector<T extends Entity, Relations = {}, Selected = unknown>(
    store: StoreHandleOwner<T, Relations>,
    selector: (snapshot: StoreSnapshot<T>) => Selected,
    isEqual: (a: Selected, b: Selected) => boolean,
    tag: string
): Selected {
    const selectorRef = useRef(selector)
    const isEqualRef = useRef(isEqual)
    selectorRef.current = selector
    isEqualRef.current = isEqual

    const cacheRef = useRef<{ store: StoreHandleOwner<T, Relations>; snapshot: StoreSnapshot<T>; selection: Selected } | null>(null)

    const getSnapshot = () => {
        const snapshot = getStoreSnapshot(store, tag) as StoreSnapshot<T>
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

    const subscribe = (listener: () => void) => subscribeStore(store, listener, tag)
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
