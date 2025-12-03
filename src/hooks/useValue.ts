import { Atom, PrimitiveAtom, atom, createStore } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { globalStore } from '../core/BaseStore'
import { IStore, StoreKey } from '../core/types'

/**
 * React hook to subscribe to a single entity by ID
 * Uses selectAtom for fine-grained updates - only re-renders when this specific item changes
 */
export function createUseValue<T>(
    objectMapAtom: PrimitiveAtom<Map<StoreKey, T>>,
    store: IStore<T>,
    jotaiStore?: ReturnType<typeof createStore>
) {
    const actualStore = jotaiStore || globalStore

    return function useValue(id?: StoreKey): T | undefined {
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

        return useAtomValue(selectedAtom, { store: actualStore })
    }
}
