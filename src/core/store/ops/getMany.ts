import type { CoreRuntime, Entity, PartialWithId, StoreReadOptions } from '../../types'
import type { EntityId } from '#protocol'
import { bulkAdd, commitAtomMapUpdateDelta } from '../internals/atomMap'
import { preserveReferenceShallow } from '../internals/preserveReference'
import { resolveObservabilityContext } from '../internals/runtime'
import { executeQuery } from '../../ops/opsExecutor'
import type { StoreHandle } from '../internals/handleTypes'

export function createGetMany<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    const { jotaiStore, atom, transform } = handle

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
            const { data } = await executeQuery(clientRuntime, handle, { where: { id: { in: missingUnique } } } as any, observabilityContext)

            const before = jotaiStore.get(atom) as Map<EntityId, T>
            const fetchedById = new Map<EntityId, T>()
            const itemsToCache: T[] = []

            for (const got of data) {
                if (got === undefined) continue
                const transformed = transform(got as T)
                const id = (transformed as any).id as EntityId

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
                    const changedIds = new Set<EntityId>()
                    for (const item of itemsToCache) {
                        const id = (item as any).id as EntityId
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
