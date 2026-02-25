import type { ObservabilityContext } from 'atoma-types/observability'
import type { OtlpExporterOptions } from './exporter/OtlpExporter'
import type { PinoExporterOptions } from './exporter/PinoExporter'
import type { StoreObservabilityConfig } from './store-observability'

export type ObservabilityPluginOptions = Readonly<{
    eventPrefix?: string
    maxTraceEvents?: number
    maxRuntimeTraces?: number
    pino?: Readonly<PinoExporterOptions & { enabled?: boolean }>
    otlp?: Readonly<Partial<OtlpExporterOptions> & { enabled?: boolean }>
}>

export type ObservabilityExtension = Readonly<{
    observe: {
        createContext: (storeName: string, args?: { traceId?: string; explain?: boolean }) => ObservabilityContext
        registerStore: (config: StoreObservabilityConfig) => void
    }
}>
