import { BaseStore } from '../BaseStore'
import type { Entity, PartialWithId, StoreKey, StoreReadOptions } from '../types'
import { commitAtomMapUpdate } from './cacheWriter'
import { resolveObservabilityContext } from './runtime'
import type { StoreHandle } from '../types'

export function createGetAll<T extends Entity>(handle: StoreHandle<T>) {
    const { jotaiStore, atom, adapter, services, indexes, transform } = handle

    return async (filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean, options?: StoreReadOptions) => {
        const existingMap = jotaiStore.get(atom) as Map<StoreKey, T>
        const observabilityContext = resolveObservabilityContext(handle, options)

        let arr = await adapter.getAll(filter, observabilityContext)
        arr = arr.map(transform)

        const incomingIds = new Set(arr.map(i => (i as any).id as StoreKey))
        const toRemove: StoreKey[] = []
        existingMap.forEach((_value: T, id: StoreKey) => {
            if (!incomingIds.has(id)) toRemove.push(id)
        })

        const itemsToCache = cacheFilter ? arr.filter(cacheFilter) : arr

        const withRemovals = BaseStore.bulkRemove(toRemove, existingMap)
        const next = BaseStore.bulkAdd(itemsToCache as PartialWithId<T>[], withRemovals)
        commitAtomMapUpdate({ handle, before: existingMap, after: next })

        return arr
    }
}
