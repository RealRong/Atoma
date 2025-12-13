import { PrimitiveAtom, createStore } from 'jotai'
import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { globalStore } from '../core/BaseStore'
import { Entity, RelationMap, StoreKey } from '../core/types'
import { useRelations } from './useRelations'

/**
 * React hook to subscribe to entire collection
 * Returns all items as an array
 */
export function createUseAll<T extends Entity, Relations extends RelationMap<T> = {}>(
    objectMapAtom: PrimitiveAtom<Map<StoreKey, T>>,
    store: { _relations?: Relations },
    jotaiStore?: ReturnType<typeof createStore>
) {
    const actualStore = jotaiStore || globalStore

    return function useAll<Include extends Partial<Record<keyof Relations, any>> = {}>(
        options?: { include?: Include }
    ): T[] {
        const all = useAtomValue(objectMapAtom, { store: actualStore })

        const memoedArr = useMemo(() => {
            return Array.from(all.values())
        }, [all])

        if (!options?.include || !store._relations) return memoedArr as any
        const relationsResult = useRelations(memoedArr as any, options.include as any, store._relations as any)
        return relationsResult.data as any
    }
}
