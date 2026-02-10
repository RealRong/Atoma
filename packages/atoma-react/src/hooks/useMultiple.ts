import { useMemo } from 'react'
import type { Entity, IStore, RelationIncludeInput, WithRelations } from 'atoma-types/core'
import { getStoreBindings } from 'atoma-types/internal'
import { useRelations } from './useRelations'
import { useShallowStableArray } from './useShallowStableArray'
import { useStoreSelector } from './internal/useStoreSelector'

interface UseMultipleOptions<T, Relations = {}> {
    limit?: number
    unique?: boolean
    selector?: (item: T) => any
    include?: RelationIncludeInput<Relations>
}

export function useMany<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: IStore<T, Relations>,
    ids: Array<T['id']> = [],
    options?: UseMultipleOptions<T, Relations> & { include?: Include }
): (keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]) {
    type Result = keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]

    const { limit, unique = true, selector, include } = options || {}

    const stableIds = useShallowStableArray(ids)

    const selectorFn = useMemo(() => {
        const idsSnapshot = stableIds.slice()
        return (map: ReadonlyMap<T['id'], T>): T[] => {
            if (!idsSnapshot.length) return []
            const seen = new Set<T['id']>()
            const arr: T[] = []

            for (const id of idsSnapshot) {
                if (unique && seen.has(id)) continue
                const item = map.get(id)
                if (!item) continue

                seen.add(id)
                arr.push(item)

                if (limit !== undefined && arr.length >= limit) break
            }

            return arr
        }
    }, [stableIds, limit, unique])

    const shallowEqual = (a: T[], b: T[]) => {
        if (a === b) return true
        if (a.length !== b.length) return false
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false
        }
        return true
    }

    const baseList = useStoreSelector(store, selectorFn, shallowEqual, 'useMany')

    const bindings = getStoreBindings(store, 'useMany')
    const relations = bindings.relations?.() as Relations | undefined
    const effectiveInclude = (include ?? ({} as Include))
    const relationsResult = useRelations<T, Relations, Include>(
        baseList,
        effectiveInclude,
        relations,
        (name) => bindings.ensureStore(name)
    )
    const withRelations = relationsResult.data

    return useMemo(() => {
        if (!selector) return withRelations as unknown as Result
        return withRelations.map(selector) as unknown as Result
    }, [withRelations, selector]) as Result
}
