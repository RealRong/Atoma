import type { ClientPlugin } from 'atoma-types/client/plugins'
import type { Entity } from 'atoma-types/core'
import type {
    ReadFinishArgs,
    ReadStartArgs,
    WriteCommittedArgs,
    WriteFailedArgs,
    WritePatchesArgs,
    WriteStartArgs,
} from 'atoma-types/runtime'
import type { ObservabilityContext } from 'atoma-types/observability'
import { StoreObservability } from './store-observability'
import type { ObservabilityExtension, ObservabilityPluginOptions } from './types'

type WriteContextEntry = {
    ctx: ObservabilityContext
    storeName: string
}

export function observabilityPlugin(options: ObservabilityPluginOptions = {}): ClientPlugin<ObservabilityExtension> {
    const storeObs = new StoreObservability()
    const prefix = String(options.eventPrefix ?? 'obs')

    const readContextByQuery = new WeakMap<object, ObservabilityContext>()
    const writeContextByAction = new Map<string, WriteContextEntry>()

    const getWriteContext = (storeName: string, actionId: string): WriteContextEntry => {
        const key = String(actionId)
        const existing = writeContextByAction.get(key)
        if (existing) return existing
        const ctxInstance = storeObs.createContext(storeName, { traceId: actionId })
        const created: WriteContextEntry = { ctx: ctxInstance, storeName }
        writeContextByAction.set(key, created)
        return created
    }

    const releaseWriteContext = (actionId: string) => {
        const key = String(actionId)
        if (!writeContextByAction.has(key)) return
        writeContextByAction.delete(key)
    }

    return {
        id: 'atoma-observability',
        setup: (_ctx) => {
            const stopEvents = _ctx.events.register({
                read: {
                    onStart: <T extends Entity>(args: ReadStartArgs<T>) => {
                        const { handle, query } = args
                        const ctxInstance = storeObs.createContext(String(handle.storeName))
                        if (query && typeof query === 'object') {
                            readContextByQuery.set(query as object, ctxInstance)
                        }
                        ctxInstance.emit(`${prefix}:read:start`, {
                            storeName: String(handle.storeName),
                            query
                        })
                    },
                    onFinish: <T extends Entity>(args: ReadFinishArgs<T>) => {
                        const { handle, query, result, durationMs } = args
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
                    onStart: <T extends Entity>(args: WriteStartArgs<T>) => {
                        const { handle, opContext, entryCount } = args
                        const entry = getWriteContext(String(handle.storeName), opContext.actionId)
                        entry.ctx.emit(`${prefix}:write:start`, {
                            storeName: entry.storeName,
                            actionId: opContext.actionId,
                            origin: opContext.origin,
                            scope: opContext.scope,
                            entryCount
                        })
                    },
                    onPatches: <T extends Entity>(args: WritePatchesArgs<T>) => {
                        const { handle, opContext, patches } = args
                        const entry = getWriteContext(String(handle.storeName), opContext.actionId)
                        entry.ctx.emit(`${prefix}:write:patches`, {
                            storeName: entry.storeName,
                            actionId: opContext.actionId,
                            patchCount: Array.isArray(patches) ? patches.length : 0
                        })
                    },
                    onCommitted: <T extends Entity>(args: WriteCommittedArgs<T>) => {
                        const { handle, opContext } = args
                        const entry = getWriteContext(String(handle.storeName), opContext.actionId)
                        entry.ctx.emit(`${prefix}:write:finish`, {
                            storeName: entry.storeName,
                            actionId: opContext.actionId
                        })
                        releaseWriteContext(opContext.actionId)
                    },
                    onFailed: <T extends Entity>(args: WriteFailedArgs<T>) => {
                        const { handle, opContext, error } = args
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
                        },
                        registerStore: (config) => {
                            storeObs.registerStore(config)
                        }
                    }
                },
                dispose: () => {
                    try {
                        stopEvents?.()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
