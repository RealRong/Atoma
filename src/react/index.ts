export { createReactStore } from './createReactStore'
export type { ReactStore, ReactStoreConfig } from './createReactStore'

export type { UseFindManyResult } from './types'

export { createUseValue, createUseAll, createUseFindMany, createUseMultiple, useFuzzySearch } from './hooks'

export { defineEntities } from './createAtomaClient'
export type { AtomaClient, AtomaClientContext, AtomaStoresConfig, DefineClientConfig, StoresDefinition, EntitiesDefinition } from './createAtomaClient'

export { createAtomaStore } from './createAtomaStore'
export type { CreateAtomaStoreOptions, RelationsDsl } from './createAtomaStore'

export {
    Store,
    setDefaultAdapterFactory,
    registerStore,
    clearStoreCache,
    preloadStores,
    getLoadedStores,
    getStoreConfig
} from './registry'

export type {
    StoreRegistry,
    RegistryStoreConfig,
    AdapterFactory
} from '../registry/types'
