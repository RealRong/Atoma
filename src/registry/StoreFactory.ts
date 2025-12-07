import { createSyncStore, type SyncStore } from '../core/createSyncStore'
import type { AdapterFactory, RegistryStoreConfig, StoreRegistry } from './types'
import type { HTTPAdapterConfig } from '../adapters/HTTPAdapter'
import { HTTPAdapter } from '../adapters/HTTPAdapter'

const storeCache = new Map<keyof StoreRegistry, SyncStore<any>>()
const customConfigs = new Map<keyof StoreRegistry, RegistryStoreConfig<any>>()
const customResourceConfigs: Record<string, Partial<HTTPAdapterConfig<any>>> = {}

let defaultAdapterFactory: AdapterFactory | null = null
let isInitialized = false

const lockInitialization = () => {
    if (process.env.NODE_ENV !== 'test') {
        isInitialized = true
    }
}

/**
 * Options for setDefaultAdapterFactory
 */
export interface AdapterFactoryOptions {
    /** Custom configuration overrides for specific resources */
    custom?: Record<string, Partial<HTTPAdapterConfig<any>>>
}

/**
 * Set the default adapter factory function
 * @param factory Function that creates an adapter given a resource name
 * @param options Optional configuration including custom per-resource overrides
 */
export function setDefaultAdapterFactory(
    factory: AdapterFactory,
    options?: AdapterFactoryOptions
): void {
    if (isInitialized && process.env.NODE_ENV !== 'test') {
        throw new Error(
            '[Atoma StoreRegistry] Cannot call setDefaultAdapterFactory after initialization.\n' +
            'This function must be called during app startup before any Store() calls.'
        )
    }

    defaultAdapterFactory = factory

    // Store custom resource configurations
    if (options?.custom) {
        Object.assign(customResourceConfigs, options.custom)
    }

    lockInitialization()
}

export function registerStore<K extends keyof StoreRegistry>(
    name: K,
    config: RegistryStoreConfig<StoreRegistry[K]>
): void {
    if (storeCache.has(name) && process.env.NODE_ENV !== 'test') {
        throw new Error(
            `[Atoma StoreRegistry] Cannot registerStore('${String(name)}') after it has been accessed.`
        )
    }

    customConfigs.set(name, config)
}

export function Store<K extends keyof StoreRegistry>(
    name: K
): SyncStore<StoreRegistry[K]> {
    const cached = storeCache.get(name)
    if (cached) {
        return cached as SyncStore<StoreRegistry[K]>
    }

    const customConfig = customConfigs.get(name)

    if (!customConfig && !defaultAdapterFactory) {
        throw new Error(
            `[Atoma] No adapter configured for store "${String(name)}"\n\n` +
            `Please call setDefaultAdapterFactory((name) => new IndexedDBAdapter(db.table(name)))`
        )
    }

    let adapter = customConfig?.adapter

    if (!adapter) {
        // Create adapter from factory
        adapter = defaultAdapterFactory!<StoreRegistry[K]>(name as string)

        // Apply custom resource configuration if available and adapter is HTTPAdapter
        const resourceName = String(name)
        const resourceCustom = customResourceConfigs[resourceName]

        if (resourceCustom && adapter instanceof HTTPAdapter) {
            // Create new adapter with merged configuration
            const currentConfig = (adapter as any).config as HTTPAdapterConfig<StoreRegistry[K]>
            adapter = new HTTPAdapter<StoreRegistry[K]>({
                ...currentConfig,
                ...resourceCustom,
                // Deep merge endpoints if both exist
                endpoints: resourceCustom.endpoints
                    ? { ...currentConfig.endpoints, ...resourceCustom.endpoints }
                    : currentConfig.endpoints
            })
        }
    }

    // Lock initialization on first successful creation to prevent hot swapping.
    lockInitialization()

    const store = createSyncStore<StoreRegistry[K]>({
        name: name as string,
        adapter,
        transformData: customConfig?.transformData,
        idGenerator: customConfig?.idGenerator,
        schema: customConfig?.schema,
        hooks: customConfig?.hooks,
        store: customConfig?.store,
        indexes: customConfig?.indexes
    })

    storeCache.set(name, store)
    return store
}

export function clearStoreCache(): void {
    if (process.env.NODE_ENV !== 'test') {
        console.warn('[Atoma StoreRegistry] clearStoreCache() should only be used in tests.')
    }
    storeCache.clear()
    customConfigs.clear()
    isInitialized = false
}

export function preloadStores<K extends keyof StoreRegistry>(...names: K[]): void {
    names.forEach(name => Store(name))
}

export function getLoadedStores(): Array<keyof StoreRegistry> {
    return Array.from(storeCache.keys())
}

export function getStoreConfig<K extends keyof StoreRegistry>(
    name: K
): RegistryStoreConfig<StoreRegistry[K]> | undefined {
    return customConfigs.get(name)
}
