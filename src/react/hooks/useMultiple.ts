import { PrimitiveAtom, createStore } from 'jotai'
import { useAtomValue } from 'jotai'
import { useMemo } from 'react'
import { globalStore } from '../../core/BaseStore'
import { Entity, IStore, InferIncludeType, OrderBy, RelationMap, StoreKey } from '../../core/types'
import { useRelations } from './useRelations'
import { resolveStoreRelations } from '../../core/storeAccessRegistry'

export interface UseMultipleOptions<T, Relations extends RelationMap<T> = {}> {
    limit?: number
    unique?: boolean
    selector?: (item: T) => any
    include?: { [K in keyof Relations]?: InferIncludeType<Relations[K]> }
}


export function createUseMultiple<T extends Entity, Relations extends RelationMap<T> = {}>(
    objectMapAtom: PrimitiveAtom<Map<StoreKey, T>>,
    store: IStore<T, Relations>,
    jotaiStore?: ReturnType<typeof createStore>
) {
    const actualStore = jotaiStore || globalStore

    return function useMultiple<Include extends { [K in keyof Relations]?: InferIncludeType<Relations[K]> } = {}>(
        ids: StoreKey[] = [],
        options?: UseMultipleOptions<T, Relations> & { include?: Include }
    ): T[] {
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
