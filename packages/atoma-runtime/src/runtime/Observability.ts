import { Observability as AtomaObservability } from 'atoma-observability'
import type { DebugConfig, DebugEvent } from 'atoma-observability'
import type { RuntimeObservability } from '../types/runtimeTypes'

const toStoreScope = (name?: string) => String(name || 'store')

export type StoreObservabilityConfig = {
    storeName: string
    debug?: DebugConfig
    debugSink?: (e: DebugEvent) => void
}

export class Observability implements RuntimeObservability {
    private observabilityConfigByStore = new Map<string, { debug?: DebugConfig; debugSink?: (e: DebugEvent) => void }>()
    private observabilityByStore = new Map<string, ReturnType<typeof AtomaObservability.runtime.create>>()

    registerStore = (config: StoreObservabilityConfig) => {
        const key = toStoreScope(config.storeName)
        this.observabilityConfigByStore.set(key, { debug: config.debug, debugSink: config.debugSink })
    }

    createContext = (storeName: string, ctxArgs?: { traceId?: string; explain?: boolean }) => {
        return this.getObservabilityRuntime(storeName).createContext(ctxArgs)
    }

    private getObservabilityRuntime = (storeName: string) => {
        const key = toStoreScope(storeName)
        const existing = this.observabilityByStore.get(key)
        if (existing) return existing

        const config = this.observabilityConfigByStore.get(key)
        const runtime = AtomaObservability.runtime.create({
            scope: key,
            debug: config?.debug,
            onEvent: config?.debugSink
        })
        this.observabilityByStore.set(key, runtime)
        return runtime
    }
}
