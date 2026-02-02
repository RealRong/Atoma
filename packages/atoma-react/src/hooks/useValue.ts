import { useEffect } from 'react'
import type { Types } from 'atoma-core'
import { getStoreRelations, resolveStore } from 'atoma/internal'
import { useStoreSelector } from './internal/useStoreSelector'
import { useRelations } from './useRelations'
import { requireStoreOwner } from './internal/storeInternal'

/**
 * React hook to subscribe to a single entity by ID
 * Uses store selector for fine-grained updates - only re-renders when this specific item changes
 */
export function useOne<T extends Types.Entity, Relations = {}, const Include extends Types.RelationIncludeInput<Relations> = {}>(
    store: Types.StoreApi<T, Relations>,
    id?: T['id'],
    options?: { include?: Types.RelationIncludeInput<Relations> & Include }
): (keyof Include extends never ? T | undefined : Types.WithRelations<T, Relations, Include> | undefined) {
    type Result = keyof Include extends never ? T | undefined : Types.WithRelations<T, Relations, Include> | undefined

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

    const { client, storeName } = requireStoreOwner(store, 'useOne')
    const relations = getStoreRelations(client, storeName) as Relations | undefined
    if (!options?.include || !relations) return base as Result

    const rel = useRelations<T, Relations, Include>(
        base ? [base] : [],
        options.include,
        relations as Relations,
        (name) => resolveStore(client, name)
    )
    return rel.data[0] as unknown as Result
}
