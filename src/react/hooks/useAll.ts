import { useMemo } from 'react'
import type { Entity, StoreApi, WithRelations, RelationIncludeInput } from '#core'
import { getStoreRelations, getStoreRuntime } from '../../core/store/internals/storeAccess'
import { useStoreSnapshot } from './internal/useStoreSelector'
import { useRelations } from './useRelations'

/**
 * React hook to subscribe to entire collection
 * Returns all items as an array
 */
export function useAll<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: StoreApi<T, Relations>,
    options?: { include?: RelationIncludeInput<Relations> & Include }
): (keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]) {
    type Result = keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]

    const all = useStoreSnapshot(store, 'useAll')
    const memoedArr = useMemo(() => Array.from(all.values()), [all])

    const relations = getStoreRelations(store, 'useAll')
    if (!options?.include || !relations) return memoedArr as Result

    const runtime = getStoreRuntime(store)
    const resolveStore = runtime?.resolveStore
    const relationsResult = useRelations<T, Relations, Include>(memoedArr, options.include, relations as Relations, resolveStore)
    return relationsResult.data as unknown as Result
}
