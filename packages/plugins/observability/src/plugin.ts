import { toError } from 'atoma-shared'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import type { StoreToken } from 'atoma-types/core'
import type { StoreEventListener, StoreEventName } from 'atoma-types/runtime'
import type { PluginOptions } from 'atoma-types/observability'
import { HUB_TOKEN } from 'atoma-types/devtools'
import { Devtools } from './devtools'
import { Runtime } from './runtime'

type LifecycleEventType =
    | 'write:start'
    | 'write:finish'
    | 'write:failed'
    | 'change:start'
    | 'change:finish'
    | 'change:failed'

const EVENT_PREFIX = 'obs'

const resolvePositiveInteger = (value: number | undefined, fallback: number): number => {
    const parsed = Number.isFinite(value) ? Math.floor(Number(value)) : fallback
    return parsed > 0 ? parsed : fallback
}

export function observabilityPlugin(options: PluginOptions = {}): ClientPlugin {
    const maxTraceEvents = resolvePositiveInteger(options.maxTraceEvents, 1000)
    const maxRuntimeTraces = resolvePositiveInteger(options.maxRuntimeTraces, 1024)

    return {
        id: 'atoma-observability',
        setup: (ctx) => {
            const devtools = new Devtools({
                sourceId: `obs.trace.${ctx.clientId}`,
                clientId: ctx.clientId,
                now: ctx.runtime.now,
                maxEvents: maxTraceEvents,
                hub: ctx.services.resolve(HUB_TOKEN)
            })

            const runtime = new Runtime({
                maxTraces: maxRuntimeTraces,
                debug: options.debug,
                onEvent: (event) => {
                    devtools.publish({
                        storeName: event.scope,
                        event
                    })
                    if (typeof options.debugSink !== 'function') return
                    try {
                        options.debugSink(event, event.scope)
                    } catch {
                        // ignore
                    }
                }
            })

            const createContext = (storeName: StoreToken | string, args?: { traceId?: string; explain?: boolean }) => {
                const scope = String(storeName || 'store')
                return runtime.createContext(args ? { ...args, scope } : { scope })
            }

            const emitLifecycle = (args: {
                storeName: StoreToken | string
                contextId: string
                type: LifecycleEventType
                payload: Record<string, unknown>
            }) => {
                createContext(args.storeName, { traceId: args.contextId }).emit(`${EVENT_PREFIX}:${args.type}`, {
                    storeName: String(args.storeName),
                    id: args.contextId,
                    ...args.payload
                })
            }

            const stopEvents: Array<() => void> = []
            const listen = <K extends StoreEventName>(name: K, listener: StoreEventListener<K>) => {
                stopEvents.push(ctx.events.on(name, listener))
            }

            listen('readStart', ({ id, storeName, query }) => {
                createContext(storeName, { traceId: id }).emit(`${EVENT_PREFIX}:read:start`, {
                    id,
                    storeName: String(storeName),
                    query
                })
            })

            listen('readFinish', ({ id, storeName, result, durationMs }) => {
                createContext(storeName, { traceId: id }).emit(`${EVENT_PREFIX}:read:finish`, {
                    id,
                    storeName: String(storeName),
                    size: Array.isArray(result?.data) ? result.data.length : 0,
                    durationMs
                })
            })

            listen('writeStart', ({ storeName, context, writeEntries }) => {
                emitLifecycle({
                    storeName,
                    contextId: context.id,
                    type: 'write:start',
                    payload: {
                        origin: context.origin,
                        scope: context.scope,
                        entryCount: writeEntries.length
                    }
                })
            })

            listen('writeCommitted', ({ storeName, context, changes }) => {
                emitLifecycle({
                    storeName,
                    contextId: context.id,
                    type: 'write:finish',
                    payload: {
                        changeCount: changes?.length ?? 0
                    }
                })
            })

            listen('writeFailed', ({ storeName, context, error }) => {
                emitLifecycle({
                    storeName,
                    contextId: context.id,
                    type: 'write:failed',
                    payload: {
                        message: toError(error).message
                    }
                })
            })

            listen('changeStart', ({ storeName, context, direction, changes }) => {
                emitLifecycle({
                    storeName,
                    contextId: context.id,
                    type: 'change:start',
                    payload: {
                        origin: context.origin,
                        scope: context.scope,
                        direction,
                        changeCount: changes.length
                    }
                })
            })

            listen('changeCommitted', ({ storeName, context, direction, changes }) => {
                emitLifecycle({
                    storeName,
                    contextId: context.id,
                    type: 'change:finish',
                    payload: {
                        direction,
                        changeCount: changes.length
                    }
                })
            })

            listen('changeFailed', ({ storeName, context, direction, error }) => {
                emitLifecycle({
                    storeName,
                    contextId: context.id,
                    type: 'change:failed',
                    payload: {
                        direction,
                        message: toError(error).message
                    }
                })
            })

            return {
                dispose: () => {
                    while (stopEvents.length) {
                        try {
                            stopEvents.pop()?.()
                        } catch {
                            // ignore
                        }
                    }
                    devtools.dispose()
                }
            }
        }
    }
}
