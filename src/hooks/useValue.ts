import { Atom, PrimitiveAtom, atom, createStore } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { globalStore } from '../core/BaseStore'
import { IStore, StoreKey, RelationMap, Entity } from '../core/types'
import { useRelations } from './useRelations'

/**
 * React hook to subscribe to a single entity by ID
 * Uses selectAtom for fine-grained updates - only re-renders when this specific item changes
 */
export function createUseValue<T extends Entity, Relations extends RelationMap<T> = {}>(
    objectMapAtom: PrimitiveAtom<Map<StoreKey, T>>,
    store: IStore<T, Relations>,
    jotaiStore?: ReturnType<typeof createStore>
) {
    const actualStore = jotaiStore || globalStore

    return function useValue<Include extends Partial<Record<keyof Relations, any>> = {}>(
        id?: StoreKey,
        options?: { include?: Include }
    ): (Include extends {} ? (T & any) : T) | undefined {
        const selectedAtom = useMemo(() => {
            if (!id) return atom(undefined)

            // Check if item exists in cache
            const exists = actualStore.get(objectMapAtom).has(id)
            if (!exists) {
                // Trigger fetch from adapter
                store.getOneById(id)
            }

            // Create selector for this specific ID
            const selected = selectAtom(objectMapAtom, map => map.get(id))
            return selected
        }, [id])

        const base = useAtomValue(selectedAtom, { store: actualStore })
        if (!options?.include || !store._relations) return base as any

        const rel = useRelations(base ? [base] : [], options.include as any, store._relations as any)
        return rel.data[0] as any
    }
}
