import type { ObservabilityContext } from 'atoma-types/observability'
import type { StoreObservabilityConfig } from './store-observability'

export type ObservabilityPluginOptions = Readonly<{
    /**
     * Customize event type names (optional).
     */
    eventPrefix?: string
    /**
     * Inject traceId/requestId into ops meta (default: true).
     */
    injectTraceMeta?: boolean
}>

export type ObservabilityExtension = Readonly<{
    observe: {
        createContext: (storeName: string, args?: { traceId?: string }) => ObservabilityContext
        registerStore: (config: StoreObservabilityConfig) => void
    }
}>
