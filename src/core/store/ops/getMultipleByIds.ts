import type { Entity, PartialWithId, StoreHandle, StoreKey, StoreReadOptions } from '../../types'
import { bulkAdd } from '../internals/atomMapOps'
import { commitAtomMapUpdateDelta } from '../internals/cacheWriter'
import { resolveObservabilityContext } from '../internals/runtime'

export function createGetMultipleByIds<T extends Entity>(handle: StoreHandle<T>) {
    const { jotaiStore, atom, dataSource, services, indexes, transform } = handle

    return async (ids: StoreKey[], cache = true, options?: StoreReadOptions) => {
        const map = jotaiStore.get(atom) as Map<StoreKey, T>

        const hitMap = new Map<StoreKey, T>()
        const missing: StoreKey[] = []

        ids.forEach(id => {
            if (map.has(id)) {
                hitMap.set(id, map.get(id) as T)
            } else {
                missing.push(id)
            }
        })

        let fetched: T[] = []
        if (missing.length > 0) {
            const observabilityContext = resolveObservabilityContext(handle, options)

            fetched = (await dataSource.bulkGet(missing, observabilityContext)).filter((i): i is T => i !== undefined)
            fetched = fetched.map(transform)

            if (cache && fetched.some(i => !map.has((i as any).id))) {
                const before = jotaiStore.get(atom) as Map<StoreKey, T>
                const after = bulkAdd(fetched as PartialWithId<T>[], before)
                const changedIds = new Set<StoreKey>(fetched.map(i => (i as any).id as StoreKey))
                commitAtomMapUpdateDelta({ handle, before, after, changedIds })
            }
        }

        const fetchedMap = new Map<StoreKey, T>(fetched.map(item => [(item as any).id, item]))

        return ids
            .map(id => hitMap.get(id) ?? fetchedMap.get(id))
            .filter((i): i is T => i !== undefined)
    }
}
