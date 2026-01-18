import type { ClientRuntime, Entity, PartialWithId, StoreHandle, StoreReadOptions } from '../../types'
import type { EntityId } from '#protocol'
import { bulkAdd, bulkRemove } from '../internals/atomMapOps'
import { commitAtomMapUpdateDelta } from '../internals/cacheWriter'
import { preserveReferenceShallow } from '../internals/preserveReference'
import { resolveObservabilityContext } from '../internals/runtime'
import { executeQuery } from '../internals/opsExecutor'

export function createGetAll<T extends Entity>(clientRuntime: ClientRuntime, handle: StoreHandle<T>) {
    const { jotaiStore, atom, transform } = handle

    return async (filter?: (item: T) => boolean, cacheFilter?: (item: T) => boolean, options?: StoreReadOptions) => {
        const existingMap = jotaiStore.get(atom) as Map<EntityId, T>
        const observabilityContext = resolveObservabilityContext(clientRuntime, handle, options)

        const { data } = await executeQuery(clientRuntime, handle, {}, observabilityContext)
        const fetched = filter ? (data as any[]).filter(filter as any) : (data as any[])

        const arr: T[] = new Array(fetched.length)
        const itemsToCache: Array<PartialWithId<T>> = []
        const incomingIds = new Set<EntityId>()

        for (let i = 0; i < fetched.length; i++) {
            const transformed = transform(fetched[i] as T)
            const id = (transformed as any).id as EntityId
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

        const toRemove: EntityId[] = []
        existingMap.forEach((_value: T, id: EntityId) => {
            if (!incomingIds.has(id)) toRemove.push(id)
        })

        const withRemovals = bulkRemove(toRemove, existingMap)
        const next = itemsToCache.length
            ? bulkAdd(itemsToCache as PartialWithId<T>[], withRemovals)
            : withRemovals

        const changedIds = new Set<EntityId>(toRemove)
        for (const item of itemsToCache) {
            const id = item.id as any as EntityId
            const beforeVal = existingMap.get(id)
            if (!existingMap.has(id) || beforeVal !== (item as any)) {
                changedIds.add(id)
            }
        }

        commitAtomMapUpdateDelta({ handle, before: existingMap, after: next, changedIds })

        return arr
    }
}
