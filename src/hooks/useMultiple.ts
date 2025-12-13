import { PrimitiveAtom, createStore } from 'jotai'
import { useAtomValue } from 'jotai'
import { useMemo } from 'react'
import { globalStore } from '../core/BaseStore'
import { Entity, InferIncludeType, OrderBy, RelationMap, StoreKey } from '../core/types'
import { useRelations } from './useRelations'

type SortDirection = 'asc' | 'desc'

export interface UseMultipleOptions<T, Relations extends RelationMap<T> = {}> {
    orderBy?: OrderBy<T>
    limit?: number
    unique?: boolean
    selector?: (item: T) => any
    include?: { [K in keyof Relations]?: InferIncludeType<Relations[K]> }
}

function sortBy<T>(items: T[], orderBy?: OrderBy<T>): T[] {
    if (!orderBy) return items
    const rules = Array.isArray(orderBy) ? orderBy : [orderBy]
    const copy = [...items]
    copy.sort((a, b) => {
        for (const { field, direction } of rules) {
            const av = (a as any)[field]
            const bv = (b as any)[field]
            if (av === bv) continue
            const cmp = av < bv ? -1 : 1
            return direction === 'asc' ? cmp : -cmp
        }
        return 0
    })
    return copy
}

export function createUseMultiple<T extends Entity, Relations extends RelationMap<T> = {}>(
    objectMapAtom: PrimitiveAtom<Map<StoreKey, T>>,
    store: { _relations?: Relations },
    jotaiStore?: ReturnType<typeof createStore>
) {
    const actualStore = jotaiStore || globalStore

    return function useMultiple<Include extends { [K in keyof Relations]?: InferIncludeType<Relations[K]> } = {}>(
        ids: StoreKey[] = [],
        options?: UseMultipleOptions<T, Relations> & { include?: Include }
    ): T[] {
        const map = useAtomValue(objectMapAtom, { store: actualStore })
        const { orderBy, limit, unique = true, selector, include } = options || {}

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

            const sorted = sortBy(arr, orderBy)
            const limited = limit !== undefined ? sorted.slice(0, limit) : sorted
            return limited
        }, [ids, map, orderBy, limit, unique])

        const relationsResult = useRelations(baseList as any, include as any, store._relations as any)
        const withRelations = relationsResult.data as any as T[]

        return useMemo(() => {
            if (!selector) return withRelations
            return withRelations.map(selector)
        }, [withRelations, selector])

        // Note: loading/error 由上层（包含 useFindMany 等）或用户使用 relationsResult?.loading 来判断
    }
}
