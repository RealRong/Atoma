import type { CursorStore, SyncApplier, SyncEvent, SyncPhase, SyncTransport } from '#sync/types'
import type { ChangeBatch, Cursor, Meta } from 'atoma-protocol'
import { AbortError, computeBackoffDelayMs, readCursorOrInitial, resolveRetryBackoff, RetryableSyncError, sleepMs, toError } from '#sync/internal'
import { createSingleflight } from '#sync/internal/singleflight'
import type { RetryBackoff } from '#sync/internal/backoff'

export class PullLane {
    private disposed = false
    private pullPending = false
    private runId = 0

    private controller = new AbortController()
    private runSignal?: AbortSignal
    private runSignalAbortHandler?: () => void

    private notifyTimer?: ReturnType<typeof setTimeout>
    private drainPromise: Promise<ChangeBatch | undefined> | null = null

    private readonly singleflight = createSingleflight<ChangeBatch | undefined>()
    private readonly retry: RetryBackoff
    private readonly allowSet: Set<string> | null

    constructor(private readonly deps: {
        cursor: CursorStore
        transport: SyncTransport
        applier: SyncApplier
        pullLimit: number
        debounceMs: number
        resources?: string[]
        initialCursor?: Cursor
        buildMeta: () => Meta
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: SyncEvent) => void
        retry?: { maxAttempts?: number }
        backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
    }) {
        this.retry = resolveRetryBackoff({
            retry: deps.retry,
            backoff: deps.backoff,
            baseDelayMs: 300
        })
        this.allowSet = deps.resources?.length ? new Set(deps.resources) : null
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
                this.controller.abort(new AbortError('[Sync] pull stopped'))
            } catch {
                // ignore
            }
            return
        }

        const onAbort = () => {
            try {
                this.controller.abort(new AbortError('[Sync] pull stopped'))
            } catch {
                // ignore
            }
        }
        this.runSignalAbortHandler = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
    }

    stop(reason: string) {
        this.runId++
        this.clearNotifyTimer()
        this.pullPending = false
        this.singleflight.cancel(new Error(reason))
        try {
            this.controller.abort(new AbortError(reason))
        } catch {
            // ignore
        }
        this.controller = new AbortController()
        this.setRunSignal(this.runSignal)
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.stop('[Sync] pull disposed')
    }

    requestPull(args: { cause: 'manual' | 'periodic' | 'notify'; resources?: string[] }): Promise<ChangeBatch | undefined> {
        if (this.disposed) return Promise.resolve(undefined)

        if (args.cause === 'notify' && !this.shouldPullForResources(args.resources)) {
            return Promise.resolve(undefined)
        }

        this.pullPending = true
        this.deps.onEvent?.({ type: 'pull:scheduled', cause: args.cause })

        const flight = this.singleflight.start()

        if (args.cause !== 'notify') {
            this.scheduleDrain()
            return flight.promise
        }

        const delay = Math.max(0, Math.floor(this.deps.debounceMs))
        if (!delay) {
            this.scheduleDrain()
            return flight.promise
        }

        this.clearNotifyTimer()
        this.notifyTimer = setTimeout(() => {
            this.notifyTimer = undefined
            this.scheduleDrain()
        }, delay)

        return flight.promise
    }

    private shouldPullForResources(resources: unknown): boolean {
        const allowSet = this.allowSet
        if (!allowSet) return true
        if (!Array.isArray(resources) || !resources.length) return true
        for (const r of resources) {
            if (typeof r === 'string' && allowSet.has(r)) return true
        }
        return false
    }

    private clearNotifyTimer() {
        if (!this.notifyTimer) return
        clearTimeout(this.notifyTimer)
        this.notifyTimer = undefined
    }

    private scheduleDrain() {
        if (this.disposed) return
        if (this.drainPromise) return

        this.drainPromise = this.runDrain()
            .catch((error) => {
                if (!(error instanceof AbortError)) {
                    this.deps.onError?.(toError(error), { phase: 'pull' })
                }
                throw error
            })
            .finally(() => {
                this.drainPromise = null
                if (this.pullPending && !this.disposed) {
                    this.scheduleDrain()
                }
            })

        void this.drainPromise.catch(() => {
            // error already routed via onError
        })
    }

    private async runDrain(): Promise<ChangeBatch | undefined> {
        if (this.disposed) return undefined
        if (!this.pullPending) return undefined

        const flight = this.singleflight.peek()
        const flightId = flight?.id

        this.deps.onEvent?.({ type: 'pull:start' })

        let lastBatch: ChangeBatch | undefined
        try {
            while (this.pullPending && !this.disposed) {
                this.pullPending = false
                const batch = await this.pullOnceWithRetry()
                if (batch) lastBatch = batch
            }

            if (flightId !== undefined) {
                this.singleflight.resolve(flightId, lastBatch)
            }
            return lastBatch
        } catch (error) {
            if (flightId !== undefined) {
                this.singleflight.reject(flightId, error)
            }
            throw error
        } finally {
            this.deps.onEvent?.({ type: 'pull:idle' })
        }
    }

    private async pullOnceWithRetry(): Promise<ChangeBatch | undefined> {
        const maxAttempts = Math.max(1, Math.floor(this.retry.maxAttempts))
        let attempt = 1

        while (true) {
            try {
                return await this.pullOnce()
            } catch (error) {
                if (error instanceof AbortError) throw error
                if (!(error instanceof RetryableSyncError)) throw error
                if (this.controller.signal.aborted) throw new AbortError('[Sync] pull stopped')
                if (attempt >= maxAttempts) throw error

                const delayMs = computeBackoffDelayMs(this.retry, attempt)
                this.deps.onEvent?.({ type: 'pull:backoff', attempt, delayMs })
                await sleepMs(delayMs, this.controller.signal)
                attempt++
            }
        }
    }

    private async pullOnce(): Promise<ChangeBatch | undefined> {
        if (this.disposed) throw new Error('PullLane disposed')

        const runId = this.runId
        const signal = this.controller.signal

        const cursor = await readCursorOrInitial({
            cursor: this.deps.cursor,
            initialCursor: this.deps.initialCursor
        })
        const limit = Math.max(1, Math.floor(this.deps.pullLimit))
        const meta = this.deps.buildMeta()
        const resources = this.deps.resources

        let batch: ChangeBatch
        try {
            batch = await this.deps.transport.pullChanges({
                cursor,
                limit,
                ...(resources?.length ? { resources } : {}),
                meta,
                signal
            })
        } catch (error) {
            const err = toError(error)
            this.deps.onError?.(err, { phase: 'pull' })
            if (signal.aborted) throw new AbortError('[Sync] pull stopped')
            throw new RetryableSyncError(err)
        }

        if (this.disposed || this.runId !== runId || signal.aborted) {
            throw new AbortError('[Sync] pull stopped')
        }

        try {
            if (batch.changes.length) {
                await Promise.resolve(this.deps.applier.applyPullChanges(batch.changes))
            }
            await Promise.resolve(this.deps.cursor.advance(batch.nextCursor))
            return batch
        } catch (error) {
            const err = toError(error)
            this.deps.onError?.(err, { phase: 'pull' })
            throw err
        }
    }
}
