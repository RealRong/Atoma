import type { PluginContext } from 'atoma-types/client/plugins'
import type { ObservabilityContext } from 'atoma-types/observability'
import type { StoreObservability } from '../store-observability'

type WriteContextEntry = {
    ctx: ObservabilityContext
    storeName: string
}

type LifecycleEventType =
    | 'write:start'
    | 'write:finish'
    | 'write:failed'
    | 'change:start'
    | 'change:finish'
    | 'change:failed'

const resolveErrorMessage = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error)
}

export class LifecycleBridge {
    private readonly readContextByQuery = new WeakMap<object, ObservabilityContext>()
    private readonly writeContextByAction = new Map<string, WriteContextEntry>()
    private readonly stopEvents: Array<() => void> = []

    private readonly ctx: PluginContext
    private readonly storeObservability: StoreObservability
    private readonly eventPrefix: string

    constructor(args: {
        ctx: PluginContext
        storeObservability: StoreObservability
        eventPrefix: string
    }) {
        this.ctx = args.ctx
        this.storeObservability = args.storeObservability
        this.eventPrefix = args.eventPrefix
    }

    mount() {
        this.stopEvents.push(this.ctx.events.on('readStart', (args) => {
            const storeName = String(args.storeName)
            const context = this.storeObservability.createContext(storeName)
            if (args.query && typeof args.query === 'object') {
                this.readContextByQuery.set(args.query as object, context)
            }
            context.emit(`${this.eventPrefix}:read:start`, {
                storeName,
                query: args.query
            })
        }))

        this.stopEvents.push(this.ctx.events.on('readFinish', (args) => {
            const storeName = String(args.storeName)
            const context = (args.query && typeof args.query === 'object')
                ? (this.readContextByQuery.get(args.query as object) ?? this.storeObservability.createContext(storeName))
                : this.storeObservability.createContext(storeName)

            if (args.query && typeof args.query === 'object') {
                this.readContextByQuery.delete(args.query as object)
            }

            context.emit(`${this.eventPrefix}:read:finish`, {
                storeName,
                size: Array.isArray(args.result?.data) ? args.result.data.length : 0,
                durationMs: args.durationMs
            })
        }))

        this.stopEvents.push(this.ctx.events.on('writeStart', (args) => {
            this.emitWriteLifecycle({
                storeName: String(args.storeName),
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
                storeName: String(args.storeName),
                context: args.context,
                type: 'write:finish',
                payload: {
                    changeCount: Array.isArray(args.changes) ? args.changes.length : 0
                },
                releaseAfter: true
            })
        }))

        this.stopEvents.push(this.ctx.events.on('writeFailed', (args) => {
            this.emitWriteLifecycle({
                storeName: String(args.storeName),
                context: args.context,
                type: 'write:failed',
                payload: {
                    message: resolveErrorMessage(args.error)
                },
                releaseAfter: true
            })
        }))

        this.stopEvents.push(this.ctx.events.on('changeStart', (args) => {
            this.emitWriteLifecycle({
                storeName: String(args.storeName),
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
                storeName: String(args.storeName),
                context: args.context,
                type: 'change:finish',
                payload: {
                    direction: args.direction,
                    changeCount: Array.isArray(args.changes) ? args.changes.length : 0
                },
                releaseAfter: true
            })
        }))

        this.stopEvents.push(this.ctx.events.on('changeFailed', (args) => {
            this.emitWriteLifecycle({
                storeName: String(args.storeName),
                context: args.context,
                type: 'change:failed',
                payload: {
                    direction: args.direction,
                    message: resolveErrorMessage(args.error)
                },
                releaseAfter: true
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
        this.writeContextByAction.clear()
    }

    private getWriteContext(storeName: string, id: string): WriteContextEntry {
        const key = String(id)
        const existing = this.writeContextByAction.get(key)
        if (existing) return existing

        const context = this.storeObservability.createContext(storeName, { traceId: id })
        const created: WriteContextEntry = {
            ctx: context,
            storeName
        }
        this.writeContextByAction.set(key, created)
        return created
    }

    private releaseWriteContext(id: string) {
        this.writeContextByAction.delete(String(id))
    }

    private emitWriteLifecycle(args: {
        storeName: string
        context: { id: string }
        type: LifecycleEventType
        payload: Record<string, unknown>
        releaseAfter?: boolean
    }) {
        const entry = this.getWriteContext(args.storeName, args.context.id)
        entry.ctx.emit(`${this.eventPrefix}:${args.type}`, {
            storeName: entry.storeName,
            id: args.context.id,
            ...args.payload
        })
        if (args.releaseAfter) {
            this.releaseWriteContext(args.context.id)
        }
    }
}
