export { createReactStore, createAtomaStore } from './createReactStore'
export type { ReactStore, ReactStoreConfig } from './createReactStore'

export type { UseFindManyResult } from './types'

export { createUseValue, createUseAll, createUseFindMany, createUseMultiple, useFuzzySearch } from './hooks'

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
