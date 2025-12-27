import type { CursorStore, SyncEvent, SyncPhase, SyncTransport } from '../types'
import type { ChangeBatch, Cursor } from '#protocol'
import { Protocol } from '#protocol'
import type { SyncApplier } from '../internal'
import { computeBackoffDelayMs } from '../policies/backoffPolicy'
import { readCursorOrInitial, toError } from '../internal'

export class SubscribeLane {
    private disposed = false
    private started = false
    private enabled = false
    private subscription?: { close: () => void }
    private reconnectTimer?: ReturnType<typeof setTimeout>
    private retryAttempt = 0

    constructor(private readonly deps: {
        cursor: CursorStore
        transport: SyncTransport
        applier: SyncApplier
        initialCursor?: Cursor
        reconnectDelayMs: number
        retry?: { maxAttempts?: number }
        backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: SyncEvent) => void
    }) {}

    start() {
        this.started = true
        this.maybeOpen()
    }

    stop() {
        this.started = false
        this.close()
        this.deps.onEvent?.({ type: 'subscribe:stopped' })
        this.retryAttempt = 0
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = undefined
        }
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.stop()
    }

    setEnabled(enabled: boolean) {
        this.enabled = enabled
        if (!enabled) {
            this.close()
            this.deps.onEvent?.({ type: 'subscribe:stopped' })
            return
        }
        this.maybeOpen()
    }

    private maybeOpen() {
        if (this.disposed || !this.started || !this.enabled) return
        if (this.subscription) return
        void this.open()
    }

    private async open() {
        try {
            const cursor = await readCursorOrInitial({
                cursor: this.deps.cursor,
                initialCursor: this.deps.initialCursor
            })
            this.subscription = this.deps.transport.subscribe({
                cursor,
                onBatch: async (batch) => {
                    try {
                        if (batch.changes.length) {
                            await Promise.resolve(this.deps.applier.applyChanges(batch.changes))
                        }
                        await this.deps.cursor.set(batch.nextCursor)
                    } catch (error) {
                        this.deps.onError?.(toError(error), { phase: 'subscribe' })
                    }
                },
                onError: (error) => {
                    this.deps.onError?.(toError(error), { phase: 'subscribe' })
                    this.close()
                    this.scheduleReconnect()
                }
            })
            this.retryAttempt = 0
            this.deps.onEvent?.({ type: 'subscribe:connected' })
        } catch (error) {
            this.deps.onError?.(toError(error), { phase: 'subscribe' })
            this.scheduleReconnect()
        }
    }

    private close() {
        if (this.subscription) {
            try {
                this.subscription.close()
            } catch {
                // ignore
            }
            this.subscription = undefined
        }
    }

    private scheduleReconnect() {
        if (!this.started || !this.enabled) return
        if (this.reconnectTimer) return
        this.retryAttempt += 1
        const maxAttempts = this.deps.retry?.maxAttempts
        if (maxAttempts !== undefined && this.retryAttempt >= Math.max(1, Math.floor(maxAttempts))) {
            return
        }

        const base = Math.max(0, Math.floor(this.deps.reconnectDelayMs))
        const backoff = this.deps.backoff ?? { baseDelayMs: base }
        const delay = computeBackoffDelayMs(this.retryAttempt, { baseDelayMs: base, ...backoff })
        this.deps.onEvent?.({ type: 'subscribe:backoff', attempt: this.retryAttempt, delayMs: delay })
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined
            this.maybeOpen()
        }, delay)
    }
}

export function subscribeToVNextChangesSse(args: {
    cursor: Cursor
    buildUrl: (cursor: Cursor) => string
    eventSourceFactory?: (url: string) => EventSource
    eventName?: string
    onBatch: (batch: ChangeBatch) => void
    onError: (error: unknown) => void
}): { close: () => void } {
    const url = args.buildUrl(args.cursor)
    const factory = args.eventSourceFactory

    let eventSource: EventSource
    if (factory) {
        eventSource = factory(url)
    } else if (typeof EventSource !== 'undefined') {
        eventSource = new EventSource(url)
    } else {
        throw new Error('[Sync] EventSource not available and no eventSourceFactory provided')
    }

    const eventName = args.eventName ?? Protocol.sse.events.CHANGES

    eventSource.addEventListener(eventName, (event: any) => {
        try {
            const batch = Protocol.sse.parse.changeBatch(String(event.data))
            args.onBatch(batch)
        } catch (error) {
            args.onError(error)
        }
    })

    eventSource.onerror = (error) => {
        args.onError(error)
    }

    return {
        close: () => eventSource.close()
    }
}
