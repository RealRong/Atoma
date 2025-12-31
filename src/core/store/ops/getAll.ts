import type { Entity, PartialWithId, StoreHandle, StoreKey, StoreReadOptions } from '../../types'
import { bulkAdd, bulkRemove } from '../internals/atomMapOps'
import { commitAtomMapUpdateDelta } from '../internals/cacheWriter'
import { preserveReferenceShallow } from '../internals/preserveReference'
import { resolveObservabilityContext } from '../internals/runtime'

export function createGetAll<T extends Entity>(handle: StoreHandle<T>) {
    const { jotaiStore, atom, dataSource, transform } = handle

    return async (filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean, options?: StoreReadOptions) => {
        const existingMap = jotaiStore.get(atom) as Map<StoreKey, T>
        const observabilityContext = resolveObservabilityContext(handle, options)

        const fetched = await dataSource.getAll(filter, observabilityContext)
        const arr: T[] = new Array(fetched.length)
        const itemsToCache: Array<PartialWithId<T>> = []
        const incomingIds = new Set<StoreKey>()

        for (let i = 0; i < fetched.length; i++) {
            const transformed = transform(fetched[i] as T)
            const id = (transformed as any).id as StoreKey
            incomingIds.add(id)

            const shouldCache = cacheFilter ? cacheFilter(transformed) : true
            if (!shouldCache) {
                arr[i] = transformed
                continue
            }

            const existing = existingMap.get(id)
            const preserved = preserveReferenceShallow(existing, transformed)
            itemsToCache.push(preserved as any)
            arr[i] = preserved
        }

        const toRemove: StoreKey[] = []
        existingMap.forEach((_value: T, id: StoreKey) => {
            if (!incomingIds.has(id)) toRemove.push(id)
        })

        const withRemovals = bulkRemove(toRemove, existingMap)
        const next = itemsToCache.length
            ? bulkAdd(itemsToCache as PartialWithId<T>[], withRemovals)
            : withRemovals

        const changedIds = new Set<StoreKey>(toRemove)
        for (const item of itemsToCache) {
            const id = item.id as any as StoreKey
            const beforeVal = existingMap.get(id)
            if (!existingMap.has(id) || beforeVal !== (item as any)) {
                changedIds.add(id)
            }
        }

        commitAtomMapUpdateDelta({ handle, before: existingMap, after: next, changedIds })

        return arr
    }
}
