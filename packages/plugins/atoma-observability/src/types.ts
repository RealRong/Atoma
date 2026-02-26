import type { StoreToken } from 'atoma-types/core'
import type { DebugConfig, DebugEvent } from 'atoma-types/observability'

export type ObservabilityPluginOptions = Readonly<{
    maxTraceEvents?: number
    maxRuntimeTraces?: number
    debug?: DebugConfig
    debugSink?: (event: DebugEvent, storeName: StoreToken) => void
}>
