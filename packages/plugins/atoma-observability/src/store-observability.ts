import type { DebugConfig, DebugEvent } from 'atoma-types/observability'
import { Observability as AtomaObservability } from './observability'

const toStoreScope = (name?: string) => String(name || 'store')

export type StoreObservabilityConfig = {
    storeName: string
    debug?: DebugConfig
    debugSink?: (event: DebugEvent) => void
}

type StoreRuntimeConfig = {
    debug?: DebugConfig
    debugSink?: (event: DebugEvent) => void
}

export class StoreObservability {
    private readonly runtimeConfigByStore = new Map<string, StoreRuntimeConfig>()
    private readonly runtimeByStore = new Map<string, ReturnType<typeof AtomaObservability.runtime.create>>()
    private readonly maxTraces: number | undefined

    constructor(args: { maxTraces?: number } = {}) {
        this.maxTraces = args.maxTraces
    }

    registerStore(config: StoreObservabilityConfig) {
        const storeName = toStoreScope(config.storeName)
        this.runtimeConfigByStore.set(storeName, {
            debug: config.debug,
            debugSink: config.debugSink
        })

        if (!this.runtimeByStore.has(storeName)) return

        this.runtimeByStore.set(storeName, this.createRuntime(storeName, {
            debug: config.debug,
            debugSink: config.debugSink
        }))
    }

    createContext(storeName: string, args?: { traceId?: string; explain?: boolean }) {
        return this.getRuntime(storeName).createContext(args)
    }

    private getRuntime(storeName: string) {
        const scope = toStoreScope(storeName)
        const existing = this.runtimeByStore.get(scope)
        if (existing) return existing

        const runtime = this.createRuntime(scope, this.runtimeConfigByStore.get(scope))
        this.runtimeByStore.set(scope, runtime)
        return runtime
    }

    private createRuntime(scope: string, config?: StoreRuntimeConfig) {
        return AtomaObservability.runtime.create({
            scope,
            debug: config?.debug,
            onEvent: config?.debugSink,
            maxTraces: this.maxTraces
        })
    }
}
