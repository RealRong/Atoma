import { useEffect } from 'react'
import type { Entity, Store, RelationIncludeInput, WithRelations } from 'atoma-types/core'
import { useStoreSelector } from './internal/useStoreSelector'
import { useProjectedRelations } from './internal/useProjectedRelations'

/**
 * React hook to subscribe to a single entity by ID
 * Uses store selector for fine-grained updates - only re-renders when this specific item changes
 */
export function useOne<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: Store<T, Relations>,
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
        void store.get(id).catch((error: unknown) => {
            console.warn('[Atoma] useOne: store.get 失败', error)
        })
    }, [id, base, store])

    const rel = useProjectedRelations<T, Relations, Include>({
        store,
        items: base ? [base] : [],
        include: options?.include,
        tag: 'useOne'
    })
    return rel.data[0] as unknown as Result
}
