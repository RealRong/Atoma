import { useMemo } from 'react'
import type { Entity, Store, RelationIncludeInput, WithRelations } from 'atoma-types/core'
import { useStoreSnapshot } from './internal/useStoreSelector'
import { useProjectedRelations } from './internal/useProjectedRelations'

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
    const relationResult = useProjectedRelations<T, Relations, Include>({
        store,
        items: memoedArr,
        include: options?.include,
        tag: 'useAll'
    })
    return relationResult.data as unknown as Result
}
