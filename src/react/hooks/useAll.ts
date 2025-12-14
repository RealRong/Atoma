import { PrimitiveAtom, createStore } from 'jotai'
import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { globalStore } from '../../core/BaseStore'
import { Entity, IStore, RelationMap, StoreKey } from '../../core/types'
import { useRelations } from './useRelations'
import { resolveStoreRelations } from '../../core/storeAccessRegistry'

/**
 * React hook to subscribe to entire collection
 * Returns all items as an array
 */
export function createUseAll<T extends Entity, Relations extends RelationMap<T> = {}>(
    objectMapAtom: PrimitiveAtom<Map<StoreKey, T>>,
    store: IStore<T, Relations>,
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

        const relations = resolveStoreRelations<T>(store as any) as any
        if (!options?.include || !relations) return memoedArr as any
        const relationsResult = useRelations(memoedArr as any, options.include as any, relations)
        return relationsResult.data as any
    }
}
