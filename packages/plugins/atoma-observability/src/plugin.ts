import type { ClientPlugin } from 'atoma-types/client/plugins'
import { HUB_TOKEN } from 'atoma-types/devtools'
import { LifecycleBridge } from './lifecycle/LifecycleBridge'
import { StoreObservability } from './store-observability'
import { TraceStore } from './storage/TraceStore'
import { CompositeExporter } from './exporter/CompositeExporter'
import { DevtoolsExporter } from './exporter/DevtoolsExporter'
import { OtlpExporter } from './exporter/OtlpExporter'
import { PinoExporter } from './exporter/PinoExporter'
import type { EventExporter } from './exporter/types'
import type { ObservabilityExtension, ObservabilityPluginOptions } from './types'

const resolvePositiveInteger = (value: number | undefined, fallback: number): number => {
    const parsed = Number.isFinite(value) ? Math.floor(Number(value)) : fallback
    return parsed > 0 ? parsed : fallback
}

export function observabilityPlugin(options: ObservabilityPluginOptions = {}): ClientPlugin<ObservabilityExtension> {
    const eventPrefix = String(options.eventPrefix ?? 'obs')
    const maxTraceEvents = resolvePositiveInteger(options.maxTraceEvents, 1000)
    const maxRuntimeTraces = resolvePositiveInteger(options.maxRuntimeTraces, 1024)

    const storeObservability = new StoreObservability({
        maxTraces: maxRuntimeTraces
    })

    return {
        id: 'atoma-observability',
        setup: (ctx) => {
            const sourceId = `obs.trace.${ctx.clientId}`
            const traceStore = new TraceStore({
                maxEvents: maxTraceEvents
            })

            const exporters: EventExporter[] = [
                new DevtoolsExporter({
                    sourceId,
                    clientId: ctx.clientId,
                    runtimeNow: ctx.runtime.now,
                    traceStore,
                    hub: ctx.services.resolve(HUB_TOKEN)
                })
            ]

            if (options.pino?.enabled) {
                exporters.push(new PinoExporter(options.pino))
            }

            if (options.otlp?.enabled) {
                const endpoint = typeof options.otlp.endpoint === 'string' ? options.otlp.endpoint.trim() : ''
                if (!endpoint) {
                    throw new Error('[Atoma] observabilityPlugin otlp.enabled=true 时必须提供 otlp.endpoint')
                }
                exporters.push(new OtlpExporter({
                    endpoint,
                    headers: options.otlp.headers,
                    timeoutMs: options.otlp.timeoutMs,
                    retries: options.otlp.retries,
                    concurrency: options.otlp.concurrency,
                    batchSize: options.otlp.batchSize
                }))
            }

            const exporter = new CompositeExporter(exporters)
            const lifecycleBridge = new LifecycleBridge({
                ctx,
                storeObservability,
                eventPrefix
            })
            lifecycleBridge.mount()

            return {
                extension: {
                    observe: {
                        createContext: (storeName, args) => {
                            return storeObservability.createContext(String(storeName), args)
                        },
                        registerStore: (config) => {
                            const storeName = String(config.storeName)
                            const userSink = config.debugSink

                            storeObservability.registerStore({
                                ...config,
                                storeName,
                                debugSink: (event) => {
                                    exporter.publish({
                                        storeName,
                                        event
                                    })

                                    if (typeof userSink !== 'function') return
                                    try {
                                        userSink(event)
                                    } catch {
                                        // ignore
                                    }
                                }
                            })
                        }
                    }
                },
                dispose: () => {
                    lifecycleBridge.dispose()
                    void exporter.dispose().catch(() => {
                        // ignore
                    })
                }
            }
        }
    }
}
