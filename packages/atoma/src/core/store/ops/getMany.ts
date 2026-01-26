import type { CoreRuntime, Entity, PartialWithId, StoreReadOptions } from '../../types'
import type { EntityId } from '#protocol'
import { resolveObservabilityContext } from '../internals/storeHandleManager'
import { storeWriteEngine } from '../internals/storeWriteEngine'
import type { StoreHandle } from '../internals/handleTypes'

export function createGetMany<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    const { jotaiStore, atom } = handle

    return async (ids: EntityId[], cache = true, options?: StoreReadOptions) => {
        const beforeMap = jotaiStore.get(atom) as Map<EntityId, T>

        const out: Array<T | undefined> = new Array(ids.length)
        const missingSet = new Set<EntityId>()
        const missingUnique: EntityId[] = []

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i]
            const cached = beforeMap.get(id)
            if (cached !== undefined) {
                out[i] = cached
                continue
            }
            out[i] = undefined
            if (!missingSet.has(id)) {
                missingSet.add(id)
                missingUnique.push(id)
            }
        }

        if (missingUnique.length) {
            const observabilityContext = resolveObservabilityContext(clientRuntime, handle, options)
            const { data } = await clientRuntime.io.query(handle, { where: { id: { in: missingUnique } } } as any, observabilityContext)

            const before = jotaiStore.get(atom) as Map<EntityId, T>
            const fetchedById = new Map<EntityId, T>()
            const itemsToCache: T[] = []

            for (const got of data) {
                if (got === undefined) continue
                const processed = await clientRuntime.dataProcessor.writeback(handle, got as T)
                if (!processed) continue
                const id = (processed as any).id as EntityId

                const existing = before.get(id)
                const preserved = storeWriteEngine.preserveReferenceShallow(existing, processed)

                fetchedById.set(id, preserved)
                if (cache) {
                    itemsToCache.push(preserved)
                }
            }

            if (cache && itemsToCache.length) {
                const after = storeWriteEngine.bulkAdd(itemsToCache as PartialWithId<T>[], before)
                if (after !== before) {
                    const changedIds = new Set<EntityId>()
                    for (const item of itemsToCache) {
                        const id = (item as any).id as EntityId
                        if (!before.has(id) || before.get(id) !== item) {
                            changedIds.add(id)
                        }
                    }
                    storeWriteEngine.commitAtomMapUpdateDelta({ handle, before, after, changedIds })
                }
            }

            for (let i = 0; i < ids.length; i++) {
                if (out[i] !== undefined) continue
                const id = ids[i]
                out[i] = fetchedById.get(id)
            }
        }

        return out.filter((i): i is T => i !== undefined)
    }
}
