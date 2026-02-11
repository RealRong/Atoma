import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import type { Entity } from 'atoma-types/core'
import type { RemoteOp } from 'atoma-types/protocol'
import type {
    PersistRequest,
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

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const applyTraceMeta = (op: RemoteOp, traceId?: string, requestId?: string) => {
    if (!traceId && !requestId) return
    const baseMeta = isPlainObject((op as any).meta) ? ((op as any).meta as Record<string, unknown>) : undefined
    const nextMeta: Record<string, unknown> = baseMeta ? { ...baseMeta } : { v: 1 }

    if (typeof nextMeta.v !== 'number') nextMeta.v = 1

    const existingTraceId = (typeof nextMeta.traceId === 'string' && nextMeta.traceId) ? nextMeta.traceId : undefined
    const existingRequestId = (typeof nextMeta.requestId === 'string' && nextMeta.requestId) ? nextMeta.requestId : undefined

    if (!existingTraceId && traceId) nextMeta.traceId = traceId
    if (!existingRequestId && requestId) nextMeta.requestId = requestId

    ;(op as any).meta = nextMeta
}

const applyWriteEntryTraceMeta = (entry: any, traceId?: string, requestId?: string) => {
    if (!traceId && !requestId) return
    if (!entry || typeof entry !== 'object') return

    const item = (entry as any).item
    if (!item || typeof item !== 'object') return

    const baseMeta = isPlainObject((item as any).meta) ? ((item as any).meta as Record<string, unknown>) : {}
    const nextMeta: Record<string, unknown> = { ...baseMeta }

    const existingTraceId = (typeof nextMeta.traceId === 'string' && nextMeta.traceId) ? nextMeta.traceId : undefined
    const existingRequestId = (typeof nextMeta.requestId === 'string' && nextMeta.requestId) ? nextMeta.requestId : undefined

    if (!existingTraceId && traceId) nextMeta.traceId = traceId
    if (!existingRequestId && requestId) nextMeta.requestId = requestId

    ;(item as any).meta = nextMeta
}

export function observabilityPlugin(options: ObservabilityPluginOptions = {}): ClientPlugin<ObservabilityExtension> {
    const storeObs = new StoreObservability()
    const prefix = String(options.eventPrefix ?? 'obs')
    const injectTraceMeta = options.injectTraceMeta !== false

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

    const attachWriteTraceMeta = (req: PersistRequest<any>) => {
        if (!injectTraceMeta) return
        const actionId = req.opContext.actionId
        const entry = writeContextByAction.get(String(actionId))
        const ctxInstance = entry?.ctx ?? storeObs.createContext(String(req.storeName), { traceId: actionId })
        const traceId = ctxInstance.traceId
        if (!traceId) return
        const requestId = ctxInstance.requestId()
        for (const entry of req.writeEntries) {
            applyWriteEntryTraceMeta(entry as any, traceId, requestId)
        }
    }

    const attachReadTraceMeta = (ops: RemoteOp[]) => {
        if (!injectTraceMeta) return
        if (!Array.isArray(ops) || ops.length === 0) return

        const requestIdByTrace = new Map<string, string>()

        for (const op of ops) {
            if (!op || typeof op !== 'object') continue
            if (op.kind !== 'query') continue

            const meta = isPlainObject((op as any).meta) ? ((op as any).meta as Record<string, unknown>) : undefined
            const existingTraceId = (typeof meta?.traceId === 'string' && meta.traceId) ? meta.traceId : undefined
            if (existingTraceId) continue

            const query = (op as any)?.query?.query
            if (!query || typeof query !== 'object') continue

            const ctxInstance = readContextByQuery.get(query as object)
            if (!ctxInstance || !ctxInstance.traceId) continue

            const traceId = ctxInstance.traceId
            let requestId = requestIdByTrace.get(traceId)
            if (!requestId) {
                requestId = ctxInstance.requestId()
                requestIdByTrace.set(traceId, requestId)
            }

            applyTraceMeta(op as RemoteOp, traceId, requestId)
        }
    }

    return {
        id: 'atoma-observability',
        register: (_ctx: PluginContext, register) => {
            if (!injectTraceMeta) return

            register('ops', async (req, _ctx, next) => {
                attachReadTraceMeta(req.ops as RemoteOp[])
                return await next()
            }, { priority: 100 })

            register('persist', async (req, _ctx, next) => {
                attachWriteTraceMeta(req as PersistRequest<any>)
                return await next()
            }, { priority: 100 })
        },
        init: (ctx: PluginContext) => {
            const stop = ctx.hooks.register({
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
                        const { handle, opContext, intents } = args
                        const entry = getWriteContext(String(handle.storeName), opContext.actionId)
                        entry.ctx.emit(`${prefix}:write:start`, {
                            storeName: entry.storeName,
                            actionId: opContext.actionId,
                            origin: opContext.origin,
                            scope: opContext.scope,
                            intentCount: intents.length
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
                        stop()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
