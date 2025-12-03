import { PrimitiveAtom, createStore } from 'jotai'
import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { globalStore } from '../core/BaseStore'
import { StoreKey } from '../core/types'

/**
 * React hook to subscribe to entire collection
 * Returns all items as an array
 */
export function createUseAll<T>(objectMapAtom: PrimitiveAtom<Map<StoreKey, T>>, jotaiStore?: ReturnType<typeof createStore>) {
    const actualStore = jotaiStore || globalStore

    return function useAll(): T[] {
        const all = useAtomValue(objectMapAtom, { store: actualStore })

        const memoedArr = useMemo(() => {
            return Array.from(all.values())
        }, [all])

        return memoedArr
    }
}
