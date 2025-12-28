import type { IDataSource, StoreKey, Entity, PatchMetadata } from '#core'
import { Patch } from 'immer'

/**
 * MemoryDataSource
 * 
 * A No-Op data source that performs no persistence.
 * Used for pure local state management where data is transient (memory-only)
 * or managed entirely by other side-effects (e.g. from a real-time socket).
 */
export class MemoryDataSource<T extends Entity> implements IDataSource<T> {
    name = 'memory'

    async put(key: StoreKey, value: T): Promise<void> {
        // No-op
    }

    async bulkPut(items: T[]): Promise<void> {
        // No-op
    }

    async delete(key: StoreKey): Promise<void> {
        // No-op
    }

    async bulkDelete(keys: StoreKey[]): Promise<void> {
        // No-op
    }

    async get(key: StoreKey): Promise<T | undefined> {
        return undefined
    }

    async bulkGet(keys: StoreKey[]): Promise<(T | undefined)[]> {
        return keys.map(() => undefined)
    }

    async getAll(filter?: (item: T) => boolean): Promise<T[]> {
        return []
    }

    async applyPatches(patches: Patch[], metadata: PatchMetadata): Promise<void> {
        // No-op
    }
}
