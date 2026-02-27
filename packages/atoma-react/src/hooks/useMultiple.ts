import { useMemo } from 'react'
import type { Entity, Store, RelationIncludeInput, WithRelations } from 'atoma-types/core'
import { useShallowStableArray } from './useShallowStableArray'
import { useStoreSelector } from './internal/useStoreSelector'
import { useProjectedRelations } from './internal/useProjectedRelations'

type UseManyOptions<Relations, Include extends RelationIncludeInput<Relations>> = Readonly<{
    limit?: number
    unique?: boolean
    include?: Include
}>

const shallowEqual = <T,>(a: T[], b: T[]) => {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false
    }
    return true
}

export function useMany<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: Store<T, Relations>,
    ids: Array<T['id']> = [],
    options?: UseManyOptions<Relations, Include>
): (keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]) {
    type Result = keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]

    const { limit, unique = true, include } = options ?? {}
    const stableIds = useShallowStableArray(ids)

    const selector = useMemo(() => {
        const idsSnapshot = stableIds.slice()
        return (map: ReadonlyMap<T['id'], T>) => {
            if (!idsSnapshot.length) return []
            const seen = new Set<T['id']>()
            const selected: T[] = []

            for (const id of idsSnapshot) {
                if (unique && seen.has(id)) continue
                const item = map.get(id)
                if (!item) continue
                seen.add(id)
                selected.push(item)
                if (limit !== undefined && selected.length >= limit) break
            }

            return selected
        }
    }, [stableIds, limit, unique])

    const base = useStoreSelector(store, selector, shallowEqual, 'useMany')
    const relationResult = useProjectedRelations<T, Relations, Include>({
        store,
        items: base,
        include,
        tag: 'useMany'
    })

    return relationResult.data as Result
}
