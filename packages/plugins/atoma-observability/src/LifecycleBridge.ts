import type { PluginContext } from 'atoma-types/client/plugins'
import type { StoreToken } from 'atoma-types/core'
import type { ObservabilityContext } from 'atoma-types/observability'
import type { ObservabilityRuntime } from './ObservabilityRuntime'

type RuntimeResolver = (storeName: StoreToken | string) => ObservabilityRuntime

type LifecycleEventType =
    | 'write:start'
    | 'write:finish'
    | 'write:failed'
    | 'change:start'
    | 'change:finish'
    | 'change:failed'

const EVENT_PREFIX = 'obs'

const resolveErrorMessage = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error)
}

export class LifecycleBridge {
    private readonly readContextByQuery = new WeakMap<object, ObservabilityContext>()
    private readonly stopEvents: Array<() => void> = []
    private readonly ctx: PluginContext
    private readonly ensureStoreRuntime: RuntimeResolver

    constructor(args: {
        ctx: PluginContext
        ensureStoreRuntime: RuntimeResolver
    }) {
        this.ctx = args.ctx
        this.ensureStoreRuntime = args.ensureStoreRuntime
    }

    mount() {
        this.ctx.runtime.stores.list().forEach((storeName) => {
            this.ensureStoreRuntime(storeName)
        })

        this.stopEvents.push(this.ctx.events.on('storeCreated', (args) => {
            this.ensureStoreRuntime(args.storeName)
        }))

        this.stopEvents.push(this.ctx.events.on('readStart', (args) => {
            const context = this.createContext(args.storeName)
            if (args.query && typeof args.query === 'object') {
                this.readContextByQuery.set(args.query as object, context)
            }
            context.emit(`${EVENT_PREFIX}:read:start`, {
                storeName: String(args.storeName),
                query: args.query
            })
        }))

        this.stopEvents.push(this.ctx.events.on('readFinish', (args) => {
            const context = (args.query && typeof args.query === 'object')
                ? (this.readContextByQuery.get(args.query as object) ?? this.createContext(args.storeName))
                : this.createContext(args.storeName)

            if (args.query && typeof args.query === 'object') {
                this.readContextByQuery.delete(args.query as object)
            }

            context.emit(`${EVENT_PREFIX}:read:finish`, {
                storeName: String(args.storeName),
                size: Array.isArray(args.result?.data) ? args.result.data.length : 0,
                durationMs: args.durationMs
            })
        }))

        this.stopEvents.push(this.ctx.events.on('writeStart', (args) => {
            this.emitWriteLifecycle({
                storeName: args.storeName,
                context: args.context,
                type: 'write:start',
                payload: {
                    origin: args.context.origin,
                    scope: args.context.scope,
                    entryCount: Array.isArray(args.writeEntries) ? args.writeEntries.length : 0
                }
            })
        }))

        this.stopEvents.push(this.ctx.events.on('writeCommitted', (args) => {
            this.emitWriteLifecycle({
                storeName: args.storeName,
                context: args.context,
                type: 'write:finish',
                payload: {
                    changeCount: Array.isArray(args.changes) ? args.changes.length : 0
                }
            })
        }))

        this.stopEvents.push(this.ctx.events.on('writeFailed', (args) => {
            this.emitWriteLifecycle({
                storeName: args.storeName,
                context: args.context,
                type: 'write:failed',
                payload: {
                    message: resolveErrorMessage(args.error)
                }
            })
        }))

        this.stopEvents.push(this.ctx.events.on('changeStart', (args) => {
            this.emitWriteLifecycle({
                storeName: args.storeName,
                context: args.context,
                type: 'change:start',
                payload: {
                    origin: args.context.origin,
                    scope: args.context.scope,
                    direction: args.direction,
                    changeCount: Array.isArray(args.changes) ? args.changes.length : 0
                }
            })
        }))

        this.stopEvents.push(this.ctx.events.on('changeCommitted', (args) => {
            this.emitWriteLifecycle({
                storeName: args.storeName,
                context: args.context,
                type: 'change:finish',
                payload: {
                    direction: args.direction,
                    changeCount: Array.isArray(args.changes) ? args.changes.length : 0
                }
            })
        }))

        this.stopEvents.push(this.ctx.events.on('changeFailed', (args) => {
            this.emitWriteLifecycle({
                storeName: args.storeName,
                context: args.context,
                type: 'change:failed',
                payload: {
                    direction: args.direction,
                    message: resolveErrorMessage(args.error)
                }
            })
        }))
    }

    dispose() {
        while (this.stopEvents.length) {
            try {
                this.stopEvents.pop()?.()
            } catch {
                // ignore
            }
        }
    }

    private createContext(storeName: StoreToken | string, args?: { traceId?: string; explain?: boolean }) {
        return this.ensureStoreRuntime(storeName).createContext(args)
    }

    private emitWriteLifecycle(args: {
        storeName: StoreToken | string
        context: { id: string }
        type: LifecycleEventType
        payload: Record<string, unknown>
    }) {
        this.createContext(args.storeName, { traceId: args.context.id }).emit(`${EVENT_PREFIX}:${args.type}`, {
            storeName: String(args.storeName),
            id: args.context.id,
            ...args.payload
        })
    }
}
