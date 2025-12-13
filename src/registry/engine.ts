import type { Entity, IAdapter } from '../core/types'
import type { AdapterFactory, RegistryStoreConfig, StoreRegistry } from './types'
import type { HTTPAdapterConfig } from '../adapters/HTTPAdapter'
import { HTTPAdapter } from '../adapters/HTTPAdapter'
import { setDefaultAdapterFactory as setGlobalAdapterFactory, getDefaultAdapterFactory } from '../core/defaultAdapterFactory'

export type RegistryEngineOptions = {
    createStore: (config: {
        name: string
        adapter: IAdapter<any>
        transformData?: (data: any) => any
        idGenerator?: () => string | number
        schema?: any
        hooks?: any
        store?: any
        indexes?: any
    }) => any
}

export function createRegistryEngine(options: RegistryEngineOptions) {
    const storeCache = new Map<keyof StoreRegistry, any>()
    const customConfigs = new Map<keyof StoreRegistry, RegistryStoreConfig<any>>()
    const customResourceConfigs: Record<string, Partial<HTTPAdapterConfig<any>>> = {}

    let isInitialized = false

    const lockInitialization = () => {
        if (process.env.NODE_ENV !== 'test') {
            isInitialized = true
        }
    }

    const setDefaultAdapterFactory = (
        factory: AdapterFactory,
        opts?: { custom?: Record<string, Partial<HTTPAdapterConfig<any>>> }
    ): void => {
        if (isInitialized && process.env.NODE_ENV !== 'test') {
            throw new Error(
                '[Atoma StoreRegistry] Cannot call setDefaultAdapterFactory after initialization.\n' +
                'This function must be called during app startup before any Store() calls.'
            )
        }

        setGlobalAdapterFactory(factory)

        if (opts?.custom) {
            Object.assign(customResourceConfigs, opts.custom)
        }

        lockInitialization()
    }

    const registerStore = <K extends keyof StoreRegistry>(
        name: K,
        config: RegistryStoreConfig<StoreRegistry[K]>
    ): void => {
        if (storeCache.has(name) && process.env.NODE_ENV !== 'test') {
            throw new Error(
                `[Atoma StoreRegistry] Cannot registerStore('${String(name)}') after it has been accessed.`
            )
        }

        customConfigs.set(name, config)
    }

    const Store = <K extends keyof StoreRegistry>(
        name: K
    ): any => {
        const cached = storeCache.get(name)
        if (cached) return cached

        const customConfig = customConfigs.get(name)
        const factory = getDefaultAdapterFactory()

        if (!customConfig?.adapter && !factory) {
            throw new Error(
                `[Atoma] No adapter configured for store "${String(name)}"\n\n` +
                `Please call setDefaultAdapterFactory((name) => new IndexedDBAdapter(db.table(name)))`
            )
        }

        let adapter = customConfig?.adapter as IAdapter<Entity> | undefined

        if (!adapter) {
            adapter = factory!<StoreRegistry[K]>(name as string) as unknown as IAdapter<Entity>

            const resourceName = String(name)
            const resourceCustom = customResourceConfigs[resourceName]

            if (resourceCustom && adapter instanceof HTTPAdapter) {
                const currentConfig = (adapter as any).config as HTTPAdapterConfig<StoreRegistry[K]>
                adapter = new HTTPAdapter<StoreRegistry[K]>({
                    ...currentConfig,
                    ...resourceCustom,
                    endpoints: resourceCustom.endpoints
                        ? { ...currentConfig.endpoints, ...resourceCustom.endpoints }
                        : currentConfig.endpoints
                }) as unknown as IAdapter<Entity>
            }
        }

        lockInitialization()

        const store = options.createStore({
            name: name as string,
            adapter,
            transformData: customConfig?.transformData,
            idGenerator: customConfig?.idGenerator as any,
            schema: customConfig?.schema as any,
            hooks: customConfig?.hooks as any,
            store: customConfig?.store as any,
            indexes: customConfig?.indexes as any
        })

        storeCache.set(name, store)
        return store
    }

    const clearStoreCache = (): void => {
        if (process.env.NODE_ENV !== 'test') {
            console.warn('[Atoma StoreRegistry] clearStoreCache() should only be used in tests.')
        }
        storeCache.clear()
        customConfigs.clear()
        isInitialized = false
    }

    const preloadStores = <K extends keyof StoreRegistry>(...names: K[]): void => {
        names.forEach(name => Store(name))
    }

    const getLoadedStores = (): Array<keyof StoreRegistry> => {
        return Array.from(storeCache.keys())
    }

    const getStoreConfig = <K extends keyof StoreRegistry>(
        name: K
    ): RegistryStoreConfig<StoreRegistry[K]> | undefined => {
        return customConfigs.get(name)
    }

    return {
        Store,
        setDefaultAdapterFactory,
        registerStore,
        clearStoreCache,
        preloadStores,
        getLoadedStores,
        getStoreConfig
    }
}

