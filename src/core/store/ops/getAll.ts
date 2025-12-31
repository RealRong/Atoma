import type { Entity, PartialWithId, StoreHandle, StoreKey, StoreReadOptions } from '../../types'
import { bulkAdd, bulkRemove } from '../internals/atomMapOps'
import { commitAtomMapUpdateDelta } from '../internals/cacheWriter'
import { resolveObservabilityContext } from '../internals/runtime'

export function createGetAll<T extends Entity>(handle: StoreHandle<T>) {
    const { jotaiStore, atom, dataSource, services, indexes, transform } = handle

    return async (filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean, options?: StoreReadOptions) => {
        const existingMap = jotaiStore.get(atom) as Map<StoreKey, T>
        const observabilityContext = resolveObservabilityContext(handle, options)

        let arr = await dataSource.getAll(filter, observabilityContext)
        arr = arr.map(transform)

        const incomingIds = new Set(arr.map(i => (i as any).id as StoreKey))
        const toRemove: StoreKey[] = []
        existingMap.forEach((_value: T, id: StoreKey) => {
            if (!incomingIds.has(id)) toRemove.push(id)
        })

        const itemsToCache = cacheFilter ? arr.filter(cacheFilter) : arr

        const withRemovals = bulkRemove(toRemove, existingMap)
        const next = bulkAdd(itemsToCache as PartialWithId<T>[], withRemovals)
        const changedIds = new Set<StoreKey>(toRemove)
        incomingIds.forEach(id => changedIds.add(id))
        commitAtomMapUpdateDelta({ handle, before: existingMap, after: next, changedIds })

        return arr
    }
}
