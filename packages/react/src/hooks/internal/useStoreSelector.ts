import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { Entity, Store } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import { getStoreBindings } from 'atoma-types/internal'
import { createBatchedSubscribe } from './batchedSubscribe'

type StoreSnapshot<T extends Entity> = ReadonlyMap<EntityId, T>

export function useStoreSnapshot<T extends Entity, Relations = {}>(
    store: Store<T, Relations>,
    tag: string
): StoreSnapshot<T> {
    const source = getStoreBindings(store, tag).source
    const getSnapshot = useCallback(
        () => source.getSnapshot() as StoreSnapshot<T>,
        [source]
    )
    const subscribe = useMemo(
        () => createBatchedSubscribe((listener: () => void) => source.subscribe(listener)),
        [source]
    )
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useStoreSelector<T extends Entity, Relations = {}, Selected = unknown>(
    store: Store<T, Relations>,
    selector: (snapshot: StoreSnapshot<T>) => Selected,
    isEqual: (a: Selected, b: Selected) => boolean,
    tag: string
): Selected {
    const selectorRef = useRef(selector)
    const isEqualRef = useRef(isEqual)
    selectorRef.current = selector
    isEqualRef.current = isEqual

    const cacheRef = useRef<{ store: Store<T, Relations>; snapshot: StoreSnapshot<T>; selection: Selected } | null>(null)

    const source = getStoreBindings(store, tag).source

    const getSnapshot = useCallback(() => {
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
    }, [source, store])

    const subscribe = useMemo(
        () => createBatchedSubscribe((listener: () => void) => source.subscribe(listener)),
        [source]
    )
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
