import { useEffect } from 'react'
import type { Entity, WithRelations, RelationIncludeInput, StoreApi } from '#core'
import { storeHandleManager } from '../../core/store/internals/storeHandleManager'
import { useStoreSelector } from './internal/useStoreSelector'
import { useRelations } from './useRelations'

/**
 * React hook to subscribe to a single entity by ID
 * Uses store selector for fine-grained updates - only re-renders when this specific item changes
 */
export function useOne<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: StoreApi<T, Relations>,
    id?: T['id'],
    options?: { include?: RelationIncludeInput<Relations> & Include }
): (keyof Include extends never ? T | undefined : WithRelations<T, Relations, Include> | undefined) {
    type Result = keyof Include extends never ? T | undefined : WithRelations<T, Relations, Include> | undefined

    const base = useStoreSelector(
        store,
        (map) => (id ? map.get(id) : undefined),
        Object.is,
        'useOne'
    )

    useEffect(() => {
        if (!id) return
        if (base !== undefined) return
        store.getOne(id)
    }, [id, base, store])

    const relations = storeHandleManager.getStoreRelations(store, 'useOne')
    if (!options?.include || !relations) return base as Result

    const runtime = storeHandleManager.getStoreRuntime(store)
    const resolveStore = runtime?.stores?.resolveStore
    const rel = useRelations<T, Relations, Include>(base ? [base] : [], options.include, relations as Relations, resolveStore)
    return rel.data[0] as unknown as Result
}
