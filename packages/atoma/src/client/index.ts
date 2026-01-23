export { createClient } from './internal/factory/createClient'
export { presets } from './presets'
export type { CreateClientOptions } from './types'

export type {
    ClientPlugin,
    ClientPluginContext,
    PersistHandler,
    PluginCapableClient,
    AtomaClient,
    AtomaHistory
} from './types'

export type {
    BackendConfig,
    BackendEndpointConfig,
    CustomOpsBackendConfig,
    HttpBackendConfig,
    HttpSubscribeConfig,
    HttpSyncBackendConfig,
    IndexedDBBackendConfig,
    MemoryBackendConfig,
    ResolvedBackend,
    ResolvedBackends,
    StoreBackendEndpointConfig,
    StoreCustomOpsBackendConfig
} from './types'
