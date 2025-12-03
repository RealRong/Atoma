import { createSyncStore, type SyncStore } from '../core/createSyncStore'
import type { AdapterFactory, RegistryStoreConfig, StoreRegistry } from './types'

const storeCache = new Map<keyof StoreRegistry, SyncStore<any>>()
const customConfigs = new Map<keyof StoreRegistry, RegistryStoreConfig<any>>()

let defaultAdapterFactory: AdapterFactory | null = null
let isInitialized = false

const lockInitialization = () => {
    if (process.env.NODE_ENV !== 'test') {
        isInitialized = true
    }
}

export function setDefaultAdapterFactory(factory: AdapterFactory): void {
    if (isInitialized && process.env.NODE_ENV !== 'test') {
        throw new Error(
            '[Atoma StoreRegistry] Cannot call setDefaultAdapterFactory after initialization.\n' +
            'This function must be called during app startup before any Store() calls.'
        )
    }

    defaultAdapterFactory = factory
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

    const adapter = customConfig?.adapter ||
        defaultAdapterFactory!<StoreRegistry[K]>(name as string)

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
