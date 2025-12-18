import { PrimitiveAtom, createStore } from 'jotai'
import { useAtomValue } from 'jotai'
import { useMemo } from 'react'
import { globalStore } from '../../core/BaseStore'
import { Entity, IStore, RelationIncludeInput, RelationMap, StoreKey, WithRelations } from '../../core/types'
import { useRelations } from './useRelations'
import { resolveStoreRelations } from '../../core/storeAccessRegistry'

export interface UseMultipleOptions<T, Relations = {}> {
    limit?: number
    unique?: boolean
    selector?: (item: T) => any
    include?: RelationIncludeInput<Relations>
}


export function createUseMultiple<T extends Entity, Relations = {}>(
    objectMapAtom: PrimitiveAtom<Map<StoreKey, T>>,
    store: IStore<T, Relations>,
    jotaiStore?: ReturnType<typeof createStore>
) {
    const actualStore = jotaiStore || globalStore

    return function useMultiple<const Include extends RelationIncludeInput<Relations> = {}>(
        ids: StoreKey[] = [],
        options?: UseMultipleOptions<T, Relations> & { include?: Include }
    ): (keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]) {
        const map = useAtomValue(objectMapAtom, { store: actualStore })
        const { limit, unique = true, selector, include } = options || {}

        const baseList = useMemo(() => {
            const seen = new Set<StoreKey>()
            const arr: T[] = []
            ids.forEach(id => {
                if (unique && seen.has(id)) return
                const item = map.get(id)
                if (item) {
                    seen.add(id)
                    arr.push(item)
                }
            })

            const limited = limit !== undefined ? arr.slice(0, limit) : arr
            return limited
        }, [ids, map, limit, unique])

        const relations = resolveStoreRelations<T>(store as any) as any
        const relationsResult = useRelations(baseList as any, include as any, relations)
        const withRelations = relationsResult.data as any as T[]

        return useMemo(() => {
            if (!selector) return withRelations
            return withRelations.map(selector)
        }, [withRelations, selector])

    }
}
