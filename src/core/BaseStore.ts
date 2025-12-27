import { enableMapSet, enablePatches, produce } from 'immer'
import { orderBy } from 'lodash'
import {
    Entity,
    IBase,
    PartialWithId,
    StoreDispatchEvent,
    StoreKey
} from './types'
import { getIdGenerator } from './idGenerator'

// Enable Map/Set drafting for Immer (required for Map-based atom state)
enableMapSet()
// Enable patch generation for history/adapter sync
enablePatches()

/**
 * BaseStore - Core CRUD operations on atom Maps
 */
export const BaseStore = {
    /**
     * Clear all items from map
     */
    clear<T>(data: Map<StoreKey, T>): Map<StoreKey, T> {
        return produce(data, draft => {
            draft.clear()
        })
    },

    /**
     * Add single item to map
     */
    add<T>(item: PartialWithId<T>, data: Map<StoreKey, T>): Map<StoreKey, T> {
        return produce(data, draft => {
            draft.set(item.id, item as any)
        })
    },

    /**
     * Bulk add items to map
     */
    bulkAdd<T>(items: PartialWithId<T>[], data: Map<StoreKey, T>): Map<StoreKey, T> {
        return produce(data, draft => {
            items.forEach(i => draft.set(i.id, i as any))
        })
    },

    /**
     * Bulk remove items from map
     */
    bulkRemove<T>(ids: StoreKey[], data: Map<StoreKey, T>): Map<StoreKey, T> {
        return produce(data, draft => {
            ids.forEach(id => draft.delete(id))
        })
    },

    /**
     * Dispatch an operation to the queue for batched processing
     */
    dispatch<T extends Entity>(event: StoreDispatchEvent<T>) {
        const services = event.handle.services
        services.mutation.runtime.dispatch(event)
    },

    /**
     * Remove single item from map
     */
    remove<T>(id: StoreKey, data: Map<StoreKey, T>): Map<StoreKey, T> {
        return produce(data, draft => {
            draft.delete(id)
        })
    },

    /**
     * Get item by ID
     */
    get<T>(id: StoreKey | undefined, data: Map<StoreKey, T>): T | undefined {
        if (id !== undefined && id !== null) {
            return data.get(id)
        }
    },

    /**
     * Initialize base object with timestamps and ID
     */
    initBaseObject<T extends Partial<IBase>>(obj: T, idGenerator?: () => StoreKey): PartialWithId<T> {
        const generator = idGenerator || getIdGenerator()
        return {
            ...obj,
            id: obj.id || generator(),
            updatedAt: Date.now(),
            createdAt: Date.now()
        } as PartialWithId<T>
    }
}



export default BaseStore

export type { StoreServices } from './createCoreStore'
