import type { ClientPlugin, ClientPluginContext } from 'atoma-types/client'
import type { ObservabilityContext } from 'atoma-types/observability'
import { StoreObservability } from './StoreObservability'

export type ObservabilityPluginOptions = Readonly<{
    /**
     * Customize event type names (optional).
     */
    eventPrefix?: string
}>

export type ObservabilityExtension = Readonly<{
    observe: {
        createContext: (storeName: string, args?: { traceId?: string }) => ObservabilityContext
    }
}>

type WriteContextEntry = {
    ctx: ObservabilityContext
    count: number
    storeName: string
}

export function observabilityPlugin(options: ObservabilityPluginOptions = {}): ClientPlugin<ObservabilityExtension> {
    return {
        id: 'atoma-observability',
        init: (ctx: ClientPluginContext) => {
            const storeObs = new StoreObservability()
            const prefix = String(options.eventPrefix ?? 'obs')

            const readContextByQuery = new WeakMap<object, ObservabilityContext>()
            const writeContextByAction = new Map<string, WriteContextEntry>()

            const getWriteContext = (storeName: string, actionId?: string): WriteContextEntry => {
                const key = String(actionId ?? 'unknown')
                const existing = writeContextByAction.get(key)
                if (existing) {
                    existing.count += 1
                    return existing
                }
                const ctxInstance = storeObs.createContext(storeName, { traceId: actionId })
                const created: WriteContextEntry = { ctx: ctxInstance, count: 1, storeName }
                writeContextByAction.set(key, created)
                return created
            }

            const releaseWriteContext = (actionId?: string) => {
                const key = String(actionId ?? 'unknown')
                const entry = writeContextByAction.get(key)
                if (!entry) return
                entry.count -= 1
                if (entry.count <= 0) {
                    writeContextByAction.delete(key)
                }
            }

            const stop = ctx.hooks.register({
                store: {
                    onCreated: ({ storeName, debug, debugSink }) => {
                        storeObs.registerStore({ storeName, debug, debugSink })
                    }
                },
                read: {
                    onStart: ({ handle, query }) => {
                        const ctxInstance = storeObs.createContext(String(handle.storeName))
                        if (query && typeof query === 'object') {
                            readContextByQuery.set(query as object, ctxInstance)
                        }
                        ctxInstance.emit(`${prefix}:read:start`, {
                            storeName: String(handle.storeName),
                            query
                        })
                    },
                    onFinish: ({ handle, query, result, durationMs }) => {
                        const ctxInstance = (query && typeof query === 'object')
                            ? (readContextByQuery.get(query as object) ?? storeObs.createContext(String(handle.storeName)))
                            : storeObs.createContext(String(handle.storeName))
                        if (query && typeof query === 'object') {
                            readContextByQuery.delete(query as object)
                        }
                        ctxInstance.emit(`${prefix}:read:finish`, {
                            storeName: String(handle.storeName),
                            size: Array.isArray(result?.data) ? result.data.length : 0,
                            durationMs
                        })
                    }
                },
                write: {
                    onStart: ({ handle, opContext, intents }) => {
                        const entry = getWriteContext(String(handle.storeName), opContext.actionId)
                        entry.ctx.emit(`${prefix}:write:start`, {
                            storeName: entry.storeName,
                            actionId: opContext.actionId,
                            origin: opContext.origin,
                            scope: opContext.scope,
                            intentCount: intents.length
                        })
                    },
                    onPatches: ({ handle, opContext, patches }) => {
                        const entry = getWriteContext(String(handle.storeName), opContext.actionId)
                        entry.ctx.emit(`${prefix}:write:patches`, {
                            storeName: entry.storeName,
                            actionId: opContext.actionId,
                            patchCount: Array.isArray(patches) ? patches.length : 0
                        })
                    },
                    onCommitted: ({ handle, opContext }) => {
                        const entry = getWriteContext(String(handle.storeName), opContext.actionId)
                        entry.ctx.emit(`${prefix}:write:finish`, {
                            storeName: entry.storeName,
                            actionId: opContext.actionId
                        })
                        releaseWriteContext(opContext.actionId)
                    },
                    onFailed: ({ handle, opContext, error }) => {
                        const entry = getWriteContext(String(handle.storeName), opContext.actionId)
                        entry.ctx.emit(`${prefix}:write:failed`, {
                            storeName: entry.storeName,
                            actionId: opContext.actionId,
                            message: error instanceof Error ? error.message : String(error)
                        })
                        releaseWriteContext(opContext.actionId)
                    }
                }
            })

            return {
                extension: {
                    observe: {
                        createContext: (storeName, args) => {
                            return storeObs.createContext(String(storeName), args)
                        }
                    }
                },
                dispose: () => {
                    try {
                        stop()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
