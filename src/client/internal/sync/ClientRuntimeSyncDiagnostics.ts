import type { SyncEvent, SyncPhase } from 'atoma-sync'

export type SyncDevtoolsSnapshot = {
    queue?: { pending: number; failed: number }
    lastEventAt?: number
    lastError?: string
}

export type SyncDevtoolsEvent = { type: string; payload?: any }

export class ClientRuntimeSyncDiagnostics {
    private queuePending = 0
    private queueFailed = 0
    private lastEventAt: number | undefined
    private lastError: string | undefined

    private subscribers = new Set<(e: SyncDevtoolsEvent) => void>()

    constructor(private readonly args: { enabled: boolean; now: () => number }) {}

    snapshot = (): SyncDevtoolsSnapshot => {
        if (!this.args.enabled) return {}
        return {
            queue: { pending: this.queuePending, failed: this.queueFailed },
            ...(typeof this.lastEventAt === 'number' ? { lastEventAt: this.lastEventAt } : {}),
            ...(this.lastError ? { lastError: this.lastError } : {})
        }
    }

    subscribe = (fn: (e: SyncDevtoolsEvent) => void) => {
        this.subscribers.add(fn)
        return () => {
            this.subscribers.delete(fn)
        }
    }

    wrapOnEvent = (onEvent?: (event: SyncEvent) => void) => {
        return (event: SyncEvent) => {
            if (!this.args.enabled) {
                try {
                    onEvent?.(event)
                } catch {
                    // ignore
                }
                return
            }

            this.lastEventAt = this.args.now()

            if (event.type === 'outbox:queue') {
                this.queuePending = Math.max(0, Math.floor(event.size))
                this.emit({ type: 'sync:queue', payload: { pending: this.queuePending, failed: this.queueFailed } })
            }

            if (event.type === 'outbox:queue_full') {
                this.queueFailed += 1
                this.emit({ type: 'sync:queue_full', payload: { droppedOp: event.droppedOp, maxQueueSize: event.maxQueueSize } })
            }

            this.emit({ type: 'sync:event', payload: event })

            try {
                onEvent?.(event)
            } catch {
                // ignore
            }
        }
    }

    wrapOnError = (onError?: (error: Error, context: { phase: SyncPhase }) => void) => {
        return (error: Error, context: { phase: SyncPhase }) => {
            if (this.args.enabled) {
                this.lastError = error?.message ? String(error.message) : String(error)
                this.lastEventAt = this.args.now()
                this.emit({ type: 'sync:error', payload: { error, context } })
            }

            try {
                onError?.(error, context)
            } catch {
                // ignore
            }
        }
    }

    private emit = (e: SyncDevtoolsEvent) => {
        if (!this.subscribers.size) return
        for (const sub of this.subscribers) {
            try {
                sub(e)
            } catch {
                // ignore
            }
        }
    }
}
