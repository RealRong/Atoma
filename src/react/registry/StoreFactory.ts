import { createReactStore, type ReactStore } from '../createReactStore'
import type { AdapterFactory, RegistryStoreConfig, StoreRegistry } from '../../registry/types'
import type { HTTPAdapterConfig } from '../../adapters/HTTPAdapter'
import { createRegistryEngine } from '../../registry/engine'

export interface AdapterFactoryOptions {
    custom?: Record<string, Partial<HTTPAdapterConfig<any>>>
}

const engine = createRegistryEngine({
    createStore: (config) => createReactStore(config as any)
})

export const Store = (<K extends keyof StoreRegistry>(name: K) => engine.Store(name) as ReactStore<StoreRegistry[K]>)

export const setDefaultAdapterFactory = ((factory: AdapterFactory, options?: AdapterFactoryOptions) =>
    engine.setDefaultAdapterFactory(factory, options)) as any

export const registerStore = (<K extends keyof StoreRegistry>(name: K, config: RegistryStoreConfig<StoreRegistry[K]>) =>
    engine.registerStore(name, config)) as any

export const clearStoreCache = engine.clearStoreCache
export const preloadStores = engine.preloadStores
export const getLoadedStores = engine.getLoadedStores
export const getStoreConfig = engine.getStoreConfig
