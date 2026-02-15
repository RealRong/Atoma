import type { ClientPlugin } from 'atoma-types/client/plugins'
import type { Entity } from 'atoma-types/core'
import type { DebugEvent, ObservabilityContext } from 'atoma-types/observability'
import type {
    ReadFinishArgs,
    ReadStartArgs,
    WriteCommittedArgs,
    WriteFailedArgs,
    WritePatchesArgs,
    WriteStartArgs,
} from 'atoma-types/runtime'
import type { SnapshotQuery, Source, StreamEvent } from 'atoma-types/devtools'
import { HUB_TOKEN } from 'atoma-types/devtools'
import { StoreObservability } from './store-observability'
import type { ObservabilityExtension, ObservabilityPluginOptions } from './types'

type WriteContextEntry = {
    ctx: ObservabilityContext
    storeName: string
}

type TraceRecord = {
    storeName: string
    event: DebugEvent
}

const MAX_TRACE_EVENTS = 1000

const parseCursor = (cursor?: string): number => {
    if (typeof cursor !== 'string') return 0
    const parsed = Number.parseInt(cursor, 10)
    if (Number.isNaN(parsed) || parsed < 0) return 0
    return parsed
}

const resolveLimit = (query?: SnapshotQuery): number => {
    const value = typeof query?.limit === 'number' ? Math.floor(query.limit) : 100
    if (value < 1) return 1
    if (value > 1000) return 1000
    return value
}

const resolveFilterValue = (query: SnapshotQuery | undefined, key: string): string | undefined => {
    const value = query?.filter?.[key]
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized || undefined
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
            const traceRecords: TraceRecord[] = []
            const subscribers = new Set<(event: StreamEvent) => void>()
            let revision = 0
            const sourceId = `obs.trace.${_ctx.clientId}`

            const emit = (event: StreamEvent) => {
                for (const subscriber of subscribers) {
                    try {
                        subscriber(event)
                    } catch {
                        // ignore
                    }
                }
            }

            const pushTraceEvent = ({
                storeName,
                event
            }: {
                storeName: string
                event: DebugEvent
            }) => {
                traceRecords.push({
                    storeName,
                    event
                })
                if (traceRecords.length > MAX_TRACE_EVENTS) {
                    traceRecords.splice(0, traceRecords.length - MAX_TRACE_EVENTS)
                }

                revision += 1
                const timestamp = _ctx.runtime.now()

                emit({
                    version: 1,
                    sourceId,
                    clientId: _ctx.clientId,
                    panelId: 'trace',
                    type: 'data:changed',
                    revision,
                    timestamp
                })
                emit({
                    version: 1,
                    sourceId,
                    clientId: _ctx.clientId,
                    panelId: 'timeline',
                    type: 'timeline:event',
                    revision,
                    timestamp,
                    payload: {
                        storeName,
                        event
                    }
                })
            }

            const source: Source = {
                spec: {
                    id: sourceId,
                    clientId: _ctx.clientId,
                    namespace: 'obs.trace',
                    title: 'Trace',
                    priority: 60,
                    panels: [
                        { id: 'trace', title: 'Trace', order: 60, renderer: 'timeline' },
                        { id: 'timeline', title: 'Timeline', order: 80, renderer: 'timeline' },
                        { id: 'raw', title: 'Raw', order: 999, renderer: 'raw' }
                    ],
                    capability: {
                        snapshot: true,
                        stream: true,
                        search: true,
                        paginate: true
                    },
                    tags: ['plugin', 'observability']
                },
                snapshot: (query) => {
                    const storeName = typeof query?.storeName === 'string' ? query.storeName : undefined
                    const traceId = resolveFilterValue(query, 'traceId')
                    const requestId = resolveFilterValue(query, 'requestId')
                    const eventType = resolveFilterValue(query, 'type')
                    const scope = resolveFilterValue(query, 'scope')
                    const search = typeof query?.search === 'string' ? query.search.trim().toLowerCase() : ''

                    const filtered = traceRecords
                        .slice()
                        .reverse()
                        .filter((record) => {
                            if (storeName && record.storeName !== storeName) return false
                            if (traceId && record.event.traceId !== traceId) return false
                            if (requestId && record.event.requestId !== requestId) return false
                            if (eventType && record.event.type !== eventType) return false
                            if (scope && record.event.scope !== scope) return false
                            if (search) {
                                const text = JSON.stringify(record).toLowerCase()
                                if (!text.includes(search)) return false
                            }
                            return true
                        })

                    const cursor = parseCursor(query?.cursor)
                    const limit = resolveLimit(query)
                    const sliced = filtered.slice(cursor, cursor + limit)

                    return {
                        version: 1,
                        sourceId,
                        clientId: _ctx.clientId,
                        panelId: query?.panelId ?? 'trace',
                        revision,
                        timestamp: _ctx.runtime.now(),
                        data: {
                            items: sliced.map((record) => ({
                                storeName: record.storeName,
                                ...record.event
                            }))
                        },
                        page: {
                            cursor: String(cursor),
                            nextCursor: cursor + limit < filtered.length ? String(cursor + limit) : undefined,
                            totalApprox: filtered.length
                        }
                    }
                },
                subscribe: (fn) => {
                    subscribers.add(fn)
                    return () => {
                        subscribers.delete(fn)
                    }
                }
            }

            const hub = _ctx.services.resolve(HUB_TOKEN)
            const unregisterSource = hub?.register(source)

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
                            const storeName = String(config.storeName)
                            const userSink = config.debugSink
                            storeObs.registerStore({
                                ...config,
                                storeName,
                                debugSink: (event) => {
                                    pushTraceEvent({ storeName, event })
                                    if (typeof userSink === 'function') {
                                        try {
                                            userSink(event)
                                        } catch {
                                            // ignore
                                        }
                                    }
                                }
                            })
                        }
                    }
                },
                dispose: () => {
                    try {
                        stopEvents?.()
                    } catch {
                        // ignore
                    }
                    try {
                        unregisterSource?.()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
