import { BaseStore } from '../BaseStore'
import type { Entity, PartialWithId, StoreKey } from '../types'
import { commitAtomMapUpdate } from './cacheWriter'
import type { StoreRuntime } from './runtime'

export function createGetAll<T extends Entity>(runtime: StoreRuntime<T>) {
    const { jotaiStore, atom, adapter, context, indexManager, transform } = runtime
    return async (filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean) => {
        const existingMap = jotaiStore.get(atom) as Map<StoreKey, T>
        let arr = await adapter.getAll(filter)
        arr = arr.map(transform)

        const incomingIds = new Set(arr.map(i => (i as any).id as StoreKey))
        const toRemove: StoreKey[] = []
        existingMap.forEach((_value: T, id: StoreKey) => {
            if (!incomingIds.has(id)) toRemove.push(id)
        })

        const itemsToCache = cacheFilter ? arr.filter(cacheFilter) : arr

        const withRemovals = BaseStore.bulkRemove(toRemove, existingMap)
        const next = BaseStore.bulkAdd(itemsToCache as PartialWithId<T>[], withRemovals)
        commitAtomMapUpdate({ jotaiStore, atom, before: existingMap, after: next, context, indexManager })

        return arr
    }
}
