import type { NotifyMessage, SyncEvent, SyncPhase, SyncSubscribeTransport } from 'atoma-types/sync'
import { AbortError, computeBackoffDelayMs, resolveRetryBackoff, sleepMs, toError } from '#sync/internal'
import type { RetryBackoff } from '#sync/internal/backoff'

export class NotifyLane {
    private disposed = false
    private started = false
    private enabled = false

    private subscription?: { close: () => void }
    private reconnectPromise: Promise<void> | null = null

    private controller = new AbortController()
    private runSignal?: AbortSignal
    private runSignalAbortHandler?: () => void

    private readonly retry: RetryBackoff

    constructor(private readonly deps: {
        subscribeTransport?: SyncSubscribeTransport
        resources?: string[]
        reconnectDelayMs: number
        retry?: { maxAttempts?: number }
        backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
        onNotify: (msg: NotifyMessage) => void | Promise<void>
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: SyncEvent) => void
    }) {
        const baseDelayMs = Math.max(0, Math.floor(deps.reconnectDelayMs))
        this.retry = resolveRetryBackoff({
            retry: deps.retry,
            backoff: deps.backoff,
            baseDelayMs
        })
    }

    setRunSignal(signal?: AbortSignal) {
        if (this.runSignal && this.runSignalAbortHandler) {
            try {
                this.runSignal.removeEventListener('abort', this.runSignalAbortHandler)
            } catch {
                // ignore
            }
        }

        this.runSignal = signal
        this.runSignalAbortHandler = undefined

        if (!signal) return
        if (signal.aborted) {
            try {
                this.controller.abort(new AbortError('[Sync] notify stopped'))
            } catch {
                // ignore
            }
            return
        }

        const onAbort = () => {
            try {
                this.controller.abort(new AbortError('[Sync] notify stopped'))
            } catch {
                // ignore
            }
        }
        this.runSignalAbortHandler = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
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
        try {
            this.controller.abort(new AbortError('[Sync] notify stopped'))
        } catch {
            // ignore
        }
        this.controller = new AbortController()
        this.setRunSignal(this.runSignal)
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.stop()
    }

    setEnabled(enabled: boolean) {
        this.enabled = Boolean(enabled)
        if (!this.enabled) {
            this.stop({ keepStarted: true })
            return
        }
        // New run = new cancellation scope.
        this.controller = new AbortController()
        this.setRunSignal(this.runSignal)
        this.ensureConnected()
    }

    private ensureConnected() {
        if (this.disposed || !this.started || !this.enabled) return
        if (this.subscription) return
        if (this.reconnectPromise) return

        this.reconnectPromise = this.reconnectLoop()
            .catch((error) => {
                if (error instanceof AbortError) return
                this.deps.onError?.(toError(error), { phase: 'notify' })
            })
            .finally(() => {
                this.reconnectPromise = null
            })
    }

    private async reconnectLoop(): Promise<void> {
        const maxAttempts = Math.max(1, Math.floor(this.retry.maxAttempts))
        let attempt = 1

        while (!this.disposed && this.started && this.enabled) {
            if (this.controller.signal.aborted) throw new AbortError('[Sync] notify stopped')

            try {
                await this.openOnce()
                return
            } catch (error) {
                if (this.controller.signal.aborted) throw new AbortError('[Sync] notify stopped')

                if (attempt >= maxAttempts) throw error

                const delayMs = computeBackoffDelayMs(this.retry, attempt)
                this.deps.onEvent?.({ type: 'notify:backoff', attempt, delayMs })
                await sleepMs(delayMs, this.controller.signal)
                attempt++
            }
        }
    }

    private async openOnce() {
        const subscribe = this.deps.subscribeTransport?.subscribe
        if (!subscribe) return

        this.subscription = subscribe({
            resources: this.deps.resources,
            onMessage: async (msg) => {
                try {
                    if (this.controller.signal.aborted) return
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
                this.ensureConnected()
            },
            signal: this.controller.signal
        })

        this.deps.onEvent?.({ type: 'notify:connected' })
    }

    private close() {
        if (!this.subscription) return
        try {
            this.subscription.close()
        } catch {
            // ignore
        }
        this.subscription = undefined
    }
}
