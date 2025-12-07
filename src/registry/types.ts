import type { IAdapter, LifecycleHooks, SchemaValidator, StoreKey, Entity } from '../core/types'
import type { IndexDefinition } from '../core/types'

/**
 * Global store registry interface.
 * Users extend this interface via module augmentation.
 */
export interface StoreRegistry {
    // Extended by consumers
}

/**
 * Configuration for registry-registered stores.
 * Note: indexes are intentionally omitted until createSyncStore supports them.
 */
export interface RegistryStoreConfig<T extends Entity> {
    adapter: IAdapter<T>
    transformData?: (data: T) => T
    idGenerator?: () => StoreKey
    store?: ReturnType<typeof import('jotai').createStore>
    schema?: SchemaValidator<T>
    hooks?: LifecycleHooks<T>
    indexes?: Array<IndexDefinition<T>>
}

export type AdapterFactory = <T extends Entity>(name: string) => IAdapter<T>
