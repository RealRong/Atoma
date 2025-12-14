import { BaseStore } from '../BaseStore'
import type { Entity, PartialWithId, StoreKey, StoreReadOptions } from '../types'
import { commitAtomMapUpdate } from './cacheWriter'
import { type StoreRuntime, resolveInternalOperationContext } from './runtime'

export function createGetMultipleByIds<T extends Entity>(runtime: StoreRuntime<T>) {
    const { jotaiStore, atom, adapter, context, indexManager, transform, storeName, resolveOperationTraceId } = runtime

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
            const internalContext = resolveInternalOperationContext(runtime, options)

            fetched = (await adapter.bulkGet(missing, internalContext)).filter((i): i is T => i !== undefined)
            fetched = fetched.map(transform)

            if (cache && fetched.some(i => !map.has((i as any).id))) {
                const before = jotaiStore.get(atom) as Map<StoreKey, T>
                const after = BaseStore.bulkAdd(fetched as PartialWithId<T>[], before)
                commitAtomMapUpdate({ jotaiStore, atom, before, after, context, indexManager })
            }
        }

        const fetchedMap = new Map<StoreKey, T>(fetched.map(item => [(item as any).id, item]))

        return ids
            .map(id => hitMap.get(id) ?? fetchedMap.get(id))
            .filter((i): i is T => i !== undefined)
    }
}
