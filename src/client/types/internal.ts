import type { StoreBackendEndpointConfig } from './backend'

export type StoreBackendState =
    | { role: 'local'; backend: StoreBackendEndpointConfig }
    | { role: 'remote'; backend: StoreBackendEndpointConfig }

export type StoreBatchArgs =
    | boolean
    | {
        enabled?: boolean
        maxBatchSize?: number
        flushIntervalMs?: number
        devWarnings?: boolean
    }

