import { useMemo } from 'react'
import type * as Types from 'atoma-types/core'
import { getStoreRelations, resolveStore } from 'atoma/internal'
import { useStoreSnapshot } from './internal/useStoreSelector'
import { useRelations } from './useRelations'
import { requireStoreOwner } from './internal/storeInternal'

/**
 * React hook to subscribe to entire collection
 * Returns all items as an array
 */
export function useAll<T extends Types.Entity, Relations = {}, const Include extends Types.RelationIncludeInput<Relations> = {}>(
    store: Types.StoreApi<T, Relations>,
    options?: { include?: Types.RelationIncludeInput<Relations> & Include }
): (keyof Include extends never ? T[] : Types.WithRelations<T, Relations, Include>[]) {
    type Result = keyof Include extends never ? T[] : Types.WithRelations<T, Relations, Include>[]

    const all = useStoreSnapshot(store, 'useAll')
    const memoedArr = useMemo(() => Array.from(all.values()), [all])

    const { client, storeName } = requireStoreOwner(store, 'useAll')
    const relations = getStoreRelations(client, storeName) as Relations | undefined
    if (!options?.include || !relations) return memoedArr as Result

    const relationsResult = useRelations<T, Relations, Include>(
        memoedArr,
        options.include,
        relations as Relations,
        (name) => resolveStore(client, name)
    )
    return relationsResult.data as unknown as Result
}
