import { useMemo } from 'react'
import type { Entity, Store, RelationIncludeInput, WithRelations } from 'atoma-types/core'
import { getStoreBindings } from 'atoma-types/internal'
import { useStoreSnapshot } from './internal/useStoreSelector'
import { useRelations } from './useRelations'

/**
 * React hook to subscribe to entire collection
 * Returns all items as an array
 */
export function useAll<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: Store<T, Relations>,
    options?: { include?: RelationIncludeInput<Relations> & Include }
): (keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]) {
    type Result = keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]

    const all = useStoreSnapshot(store, 'useAll')
    const memoedArr = useMemo(() => Array.from(all.values()), [all])

    const bindings = getStoreBindings(store, 'useAll')
    const relations = bindings.relations?.() as Relations | undefined
    if (!options?.include || !relations) return memoedArr as Result

    const relationsResult = useRelations<T, Relations, Include>(
        memoedArr,
        options.include,
        relations as Relations,
        (name) => bindings.ensureStore(name)
    )
    return relationsResult.data as unknown as Result
}
