export { createClient } from './internal/create/createClient'
export { presets } from './presets'
export type { CreateClientOptions } from './types'

export type {
    AtomaClient,
    AtomaHistory,
    AtomaSync,
    AtomaSyncStartMode,
    AtomaSyncStatus
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
