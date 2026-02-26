import type { ClientPlugin } from 'atoma-types/client/plugins'
import type { StoreToken } from 'atoma-types/core'
import { HUB_TOKEN } from 'atoma-types/devtools'
import { DevtoolsExporter } from './DevtoolsExporter'
import { LifecycleBridge } from './LifecycleBridge'
import { ObservabilityRuntime } from './ObservabilityRuntime'
import { TraceStore } from './TraceStore'
import type { ObservabilityPluginOptions } from './types'

const resolvePositiveInteger = (value: number | undefined, fallback: number): number => {
    const parsed = Number.isFinite(value) ? Math.floor(Number(value)) : fallback
    return parsed > 0 ? parsed : fallback
}

const toStoreScope = (storeName: StoreToken | string) => String(storeName || 'store')

const emitSafely = <T>(fn: ((value: T) => void) | undefined, value: T) => {
    if (typeof fn !== 'function') return
    try {
        fn(value)
    } catch {
        // ignore
    }
}

export function observabilityPlugin(options: ObservabilityPluginOptions = {}): ClientPlugin {
    const maxTraceEvents = resolvePositiveInteger(options.maxTraceEvents, 1000)
    const maxRuntimeTraces = resolvePositiveInteger(options.maxRuntimeTraces, 1024)

    return {
        id: 'atoma-observability',
        setup: (ctx) => {
            const runtimeByStore = new Map<string, ObservabilityRuntime>()
            const sourceId = `obs.trace.${ctx.clientId}`
            const traceStore = new TraceStore({
                maxEvents: maxTraceEvents
            })
            const exporter = new DevtoolsExporter({
                sourceId,
                clientId: ctx.clientId,
                runtimeNow: ctx.runtime.now,
                traceStore,
                hub: ctx.services.resolve(HUB_TOKEN)
            })

            const ensureStoreRuntime = (storeName: StoreToken | string): ObservabilityRuntime => {
                const scope = toStoreScope(storeName)
                const existing = runtimeByStore.get(scope)
                if (existing) return existing

                const runtime = new ObservabilityRuntime({
                    scope,
                    maxTraces: maxRuntimeTraces,
                    debug: options.debug,
                    onEvent: (event) => {
                        exporter.publish({
                            storeName: scope,
                            event
                        })
                        emitSafely((value) => options.debugSink?.(value, scope), event)
                    }
                })

                runtimeByStore.set(scope, runtime)
                return runtime
            }

            const lifecycle = new LifecycleBridge({
                ctx,
                ensureStoreRuntime
            })
            lifecycle.mount()

            return {
                dispose: () => {
                    lifecycle.dispose()
                    exporter.dispose()
                    runtimeByStore.clear()
                }
            }
        }
    }
}
