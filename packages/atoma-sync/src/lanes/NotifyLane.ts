import type { NotifyMessage, SyncEvent, SyncPhase, SyncTransport } from '#sync/types'
import { toError } from '#sync/internal'
import pRetry, { AbortError } from 'p-retry'
import { estimateDelayFromRetryContext, resolveRetryOptions } from '#sync/policies/retryPolicy'

export class NotifyLane {
    private disposed = false
    private started = false
    private enabled = false
    private subscription?: { close: () => void }
    private reconnectController?: AbortController
    private reconnectPromise?: Promise<void>
    private readonly retryOptions: ReturnType<typeof resolveRetryOptions>

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
        this.retryOptions = resolveRetryOptions({
            retry: deps.retry,
            backoff: deps.backoff,
            baseDelayMs: Math.max(0, Math.floor(deps.reconnectDelayMs)),
            unref: true
        })
    }

    start() {
        this.started = true
        this.ensureConnected()
    }

    stop(options?: { keepStarted?: boolean }) {
        if (!options?.keepStarted) {
            this.started = false
        }
        this.close()
        this.deps.onEvent?.({ type: 'notify:stopped' })
        this.abortReconnect()
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
        this.ensureConnected()
    }

    private ensureConnected() {
        if (this.disposed || !this.started || !this.enabled) return
        if (this.subscription) return
        if (this.reconnectPromise) return
        this.reconnectController = new AbortController()

        this.reconnectPromise = pRetry(async () => {
            if (this.disposed || !this.started || !this.enabled) {
                throw new AbortError('[Sync] notify stopped')
            }
            await this.openOnce()
        }, {
            ...this.retryOptions,
            signal: this.reconnectController.signal,
            onFailedAttempt: (ctx) => {
                const delayMs = estimateDelayFromRetryContext(ctx, this.retryOptions)
                this.deps.onEvent?.({ type: 'notify:backoff', attempt: ctx.attemptNumber, delayMs })
            },
            shouldRetry: (ctx) => {
                // Only retry while still started/enabled; otherwise abort via AbortError above.
                return !(ctx.error instanceof AbortError)
            }
        }).catch((error) => {
            if (error instanceof AbortError) return
            // Exhausted retries - report once.
            this.deps.onError?.(toError(error), { phase: 'notify' })
        }).finally(() => {
            this.reconnectPromise = undefined
            this.reconnectController = undefined
        })
    }

    private async openOnce() {
        try {
            const subscribe = this.deps.transport.subscribe
            if (!subscribe) return

            this.subscription = subscribe({
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
                    this.abortReconnect()
                    this.ensureConnected()
                }
            })
            this.deps.onEvent?.({ type: 'notify:connected' })
        } catch (error) {
            this.deps.onError?.(toError(error), { phase: 'notify' })
            throw error
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

    private abortReconnect() {
        try {
            this.reconnectController?.abort(new AbortError('[Sync] notify reconnect aborted'))
        } catch {
            // ignore
        }
    }
}
