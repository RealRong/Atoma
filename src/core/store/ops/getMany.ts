import type { Entity, PartialWithId, StoreHandle, StoreKey, StoreReadOptions } from '../../types'
import { bulkAdd } from '../internals/atomMapOps'
import { commitAtomMapUpdateDelta } from '../internals/cacheWriter'
import { preserveReferenceShallow } from '../internals/preserveReference'
import { resolveObservabilityContext } from '../internals/runtime'

export function createGetMany<T extends Entity>(handle: StoreHandle<T>) {
    const { jotaiStore, atom, dataSource, transform } = handle

    return async (ids: StoreKey[], cache = true, options?: StoreReadOptions) => {
        const beforeMap = jotaiStore.get(atom) as Map<StoreKey, T>

        const out: Array<T | undefined> = new Array(ids.length)
        const missingSet = new Set<StoreKey>()
        const missingUnique: StoreKey[] = []

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
            const observabilityContext = resolveObservabilityContext(handle, options)
            const fetchedList = await dataSource.bulkGet(missingUnique, observabilityContext)

            const before = jotaiStore.get(atom) as Map<StoreKey, T>
            const fetchedById = new Map<StoreKey, T>()
            const itemsToCache: T[] = []

            for (let i = 0; i < missingUnique.length; i++) {
                const got = fetchedList[i]
                if (got === undefined) continue
                const transformed = transform(got)
                const id = (transformed as any).id as StoreKey

                const existing = before.get(id)
                const preserved = preserveReferenceShallow(existing, transformed)

                fetchedById.set(id, preserved)
                if (cache) {
                    itemsToCache.push(preserved)
                }
            }

            if (cache && itemsToCache.length) {
                const after = bulkAdd(itemsToCache as PartialWithId<T>[], before)
                if (after !== before) {
                    const changedIds = new Set<StoreKey>()
                    for (const item of itemsToCache) {
                        const id = (item as any).id as StoreKey
                        if (!before.has(id) || before.get(id) !== item) {
                            changedIds.add(id)
                        }
                    }
                    commitAtomMapUpdateDelta({ handle, before, after, changedIds })
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
