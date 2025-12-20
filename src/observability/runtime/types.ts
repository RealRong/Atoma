import type { DebugConfig, DebugEvent, ObservabilityContext } from '../types'

export type ObservabilityRuntimeCreateArgs = {
    scope: string
    debug?: DebugConfig
    onEvent?: (e: DebugEvent) => void
    maxTraces?: number
}

export type ObservabilityCreateContextArgs = {
    traceId?: string
    explain?: boolean
}

export type ObservabilityRuntimeApi = {
    scope: string
    createContext: (args?: ObservabilityCreateContextArgs) => ObservabilityContext
    requestId: (traceId: string) => string
}
