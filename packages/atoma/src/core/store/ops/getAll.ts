import type { CoreRuntime, Entity, PartialWithId, StoreReadOptions } from '../../types'
import type { EntityId } from '#protocol'
import { storeHandleManager } from '../internals/storeHandleManager'
import { storeWriteEngine } from '../internals/storeWriteEngine'
import type { StoreHandle } from '../internals/handleTypes'

export function createGetAll<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    const { jotaiStore, atom } = handle

    return async (filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean, options?: StoreReadOptions) => {
        const existingMap = jotaiStore.get(atom) as Map<EntityId, T>
        const observabilityContext = storeHandleManager.resolveObservabilityContext(clientRuntime, handle, options)

        const { data } = await clientRuntime.io.query(handle, {}, observabilityContext)
        const fetched = Array.isArray(data) ? data : []
        const arr: T[] = []
        const itemsToCache: Array<PartialWithId<T>> = []
        const incomingIds = new Set<EntityId>()

        for (let i = 0; i < fetched.length; i++) {
            const processed = await clientRuntime.dataProcessor.writeback(handle, fetched[i] as T)
            if (!processed) continue
            if (filter && !filter(processed)) continue
            const id = (processed as any).id as EntityId
            incomingIds.add(id)

            const shouldCache = cacheFilter ? cacheFilter(processed) : true
            if (!shouldCache) {
                arr.push(processed)
                continue
            }

            const existing = existingMap.get(id)
            const preserved = storeWriteEngine.preserveReferenceShallow(existing, processed)
            itemsToCache.push(preserved as any)
            arr.push(preserved)
        }

        const toRemove: EntityId[] = []
        existingMap.forEach((_value: T, id: EntityId) => {
            if (!incomingIds.has(id)) toRemove.push(id)
        })

        const withRemovals = storeWriteEngine.bulkRemove(toRemove, existingMap)
        const next = itemsToCache.length
            ? storeWriteEngine.bulkAdd(itemsToCache as PartialWithId<T>[], withRemovals)
            : withRemovals

        const changedIds = new Set<EntityId>(toRemove)
        for (const item of itemsToCache) {
            const id = item.id as any as EntityId
            const beforeVal = existingMap.get(id)
            if (!existingMap.has(id) || beforeVal !== (item as any)) {
                changedIds.add(id)
            }
        }

        storeWriteEngine.commitAtomMapUpdateDelta({ handle, before: existingMap, after: next, changedIds })

        return arr
    }
}
