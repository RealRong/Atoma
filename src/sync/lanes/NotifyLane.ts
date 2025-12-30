import type { NotifyMessage, SyncEvent, SyncPhase, SyncTransport } from '../types'
import { Protocol } from '#protocol'
import { toError } from '../internal'
import { RetryBackoff } from '../policies/retryBackoff'

export class NotifyLane {
    private disposed = false
    private started = false
    private enabled = false
    private subscription?: { close: () => void }
    private reconnectTimer?: ReturnType<typeof setTimeout>
    private readonly retry: RetryBackoff

    constructor(private readonly deps: {
        transport: SyncTransport
        resources?: string[]
        reconnectDelayMs: number
        retry?: { maxAttempts?: number }
        backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
        onNotify: (msg: NotifyMessage) => void | Promise<void>
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: SyncEvent) => void
    }) {
        const baseDelayMs = Math.max(0, Math.floor(deps.reconnectDelayMs))
        this.retry = new RetryBackoff({
            retry: deps.retry,
            backoff: deps.backoff,
            baseDelayMs
        })
    }

    start() {
        this.started = true
        this.maybeOpen()
    }

    stop(options?: { keepStarted?: boolean }) {
        if (!options?.keepStarted) {
            this.started = false
        }
        this.close()
        this.deps.onEvent?.({ type: 'notify:stopped' })
        this.retry.reset()
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
            this.stop({ keepStarted: true })
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
            this.subscription = this.deps.transport.subscribe({
                resources: this.deps.resources,
                onMessage: async (msg) => {
                    try {
                        const resources = Array.isArray(msg.resources) ? msg.resources : undefined
                        this.deps.onEvent?.({ type: 'notify:message', ...(resources ? { resources } : {}) })
                        await Promise.resolve(this.deps.onNotify(msg))
                    } catch (error) {
                        this.deps.onError?.(toError(error), { phase: 'notify' })
                    }
                },
                onError: (error) => {
                    this.deps.onError?.(toError(error), { phase: 'notify' })
                    this.close()
                    this.scheduleReconnect()
                }
            })
            this.retry.reset()
            this.deps.onEvent?.({ type: 'notify:connected' })
        } catch (error) {
            this.deps.onError?.(toError(error), { phase: 'notify' })
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
        const { attempt, delayMs, stop } = this.retry.next()
        if (stop) return
        this.deps.onEvent?.({ type: 'notify:backoff', attempt, delayMs })
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined
            this.maybeOpen()
        }, delayMs)
    }
}

export function subscribeNotifySse(args: {
    resources?: string[]
    buildUrl: (args: { resources?: string[] }) => string
    eventSourceFactory?: (url: string) => EventSource
    eventName?: string
    onMessage: (msg: NotifyMessage) => void
    onError: (error: unknown) => void
}): { close: () => void } {
    const url = args.buildUrl({ resources: args.resources })
    const factory = args.eventSourceFactory

    let eventSource: EventSource
    if (factory) {
        eventSource = factory(url)
    } else if (typeof EventSource !== 'undefined') {
        eventSource = new EventSource(url)
    } else {
        throw new Error('[Sync] EventSource not available and no eventSourceFactory provided')
    }

    const eventName = args.eventName ?? Protocol.sse.events.NOTIFY

    eventSource.addEventListener(eventName, (event: any) => {
        try {
            const msg = Protocol.sse.parse.notifyMessage(String(event.data))
            args.onMessage(msg)
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
