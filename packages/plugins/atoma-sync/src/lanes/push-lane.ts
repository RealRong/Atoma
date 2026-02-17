import { AbortError, computeBackoffDelayMs, resolveRetryBackoff, RetryableSyncError, sleepMs, toError } from '#sync/internal'
import type { RetryBackoff } from '#sync/internal/backoff'
import type { OutboxStore, SyncApplier, SyncEvent, SyncOutboxItem, SyncPhase, SyncPushOutcome, SyncTransport, SyncWriteAck, SyncWriteReject } from 'atoma-types/sync'

export class PushLane {
    private disposed = false
    private enabled = true
    private runId = 0

    private controller = new AbortController()
    private runSignal?: AbortSignal
    private runSignalAbortHandler?: () => void

    private draining = false
    private drainPromise: Promise<void> | null = null
    private pending = false

    private readonly retry: RetryBackoff

    constructor(private readonly deps: {
        outbox: OutboxStore
        transport: SyncTransport
        applier: SyncApplier
        maxPushItems: number
        returning: boolean
        retry?: { maxAttempts?: number }
        backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
        now: () => number
        buildMeta: () => any
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: SyncEvent) => void
    }) {
        this.retry = resolveRetryBackoff({
            retry: deps.retry,
            backoff: deps.backoff,
            baseDelayMs: 300
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
                this.controller.abort(new AbortError('[Sync] push stopped'))
            } catch {
                // ignore
            }
            return
        }

        const onAbort = () => {
            try {
                this.controller.abort(new AbortError('[Sync] push stopped'))
            } catch {
                // ignore
            }
        }
        this.runSignalAbortHandler = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.enabled = false
        this.runId++
        try {
            this.controller.abort(new AbortError('[Sync] push disposed'))
        } catch {
            // ignore
        }
    }

    setEnabled(enabled: boolean) {
        if (this.disposed) return

        const next = Boolean(enabled)
        if (this.enabled && !next) {
            this.runId++
            try {
                this.controller.abort(new AbortError('[Sync] push stopped'))
            } catch {
                // ignore
            }
        }

        this.enabled = next
        if (this.enabled) {
            // New run = new cancellation scope.
            this.controller = new AbortController()
            this.setRunSignal(this.runSignal)
        }
    }

    requestFlush() {
        if (this.disposed || !this.enabled) return
        this.pending = true
        this.scheduleDrain()
    }

    flush(): Promise<void> {
        if (this.disposed || !this.enabled) return Promise.resolve()
        this.requestFlush()
        return this.drainPromise ?? Promise.resolve()
    }

    private scheduleDrain() {
        if (this.disposed || !this.enabled) return
        if (this.drainPromise) return

        this.drainPromise = this.runDrain()
            .catch((error) => {
                // Mirror old behavior: errors are surfaced via onError and stop this drain cycle.
                if (!(error instanceof AbortError)) {
                    this.deps.onError?.(toError(error), { phase: 'push' })
                }
            })
            .finally(() => {
                this.drainPromise = null
                if (this.pending && !this.disposed && this.enabled) {
                    this.scheduleDrain()
                }
            })
    }

    private async runDrain(): Promise<void> {
        if (this.disposed || !this.enabled) return
        if (this.draining) return

        this.draining = true
        this.deps.onEvent?.({ type: 'push:start' })

        try {
            while (!this.disposed && this.enabled) {
                const hadPending = this.pending
                this.pending = false
                const result = await this.drainUntilIdle()
                if (result === 'idle' && !this.pending && !hadPending) return
                // If there were requests while draining, loop again.
            }
        } finally {
            this.deps.onEvent?.({ type: 'push:idle' })
            this.draining = false
        }
    }

    private async drainUntilIdle(): Promise<'idle'> {
        while (!this.disposed && this.enabled) {
            const result = await this.flushBatchOnceWithRetry()
            if (result === 'idle') return 'idle'
        }
        return 'idle'
    }

    private async flushBatchOnceWithRetry(): Promise<'idle' | 'continue'> {
        const maxAttempts = Math.max(1, Math.floor(this.retry.maxAttempts))
        let attempt = 1

        // Retry loop is intentionally narrow:
        // - only RetryableSyncError triggers retry
        // - applier/store errors are not retried (they may not be idempotent)
        while (true) {
            try {
                return await this.flushBatchOnce()
            } catch (error) {
                if (error instanceof AbortError) throw error
                if (!(error instanceof RetryableSyncError)) throw error
                if (this.controller.signal.aborted) throw new AbortError('[Sync] push stopped')
                if (attempt >= maxAttempts) throw error

                const delayMs = computeBackoffDelayMs(this.retry, attempt)
                this.deps.onEvent?.({ type: 'push:backoff', attempt, delayMs })
                await sleepMs(delayMs, this.controller.signal)
                attempt++
            }
        }
    }

    private async flushBatchOnce(): Promise<'idle' | 'continue'> {
        if (this.disposed || !this.enabled) {
            throw new AbortError('[Sync] push stopped')
        }

        const runId = this.runId
        const signal = this.controller.signal

        const max = Math.max(1, Math.floor(this.deps.maxPushItems))
        const entries = await this.deps.outbox.reserve({ limit: max, nowMs: this.deps.now() })

        if (this.disposed || !this.enabled || this.runId !== runId || signal.aborted) {
            if (entries.length) {
                await this.deps.outbox.commit({ ack: [], reject: [], retryable: entries.map(e => e.idempotencyKey) })
            }
            throw new AbortError('[Sync] push stopped')
        }

        if (!entries.length) return 'idle'

        const meta = this.deps.buildMeta()
        const keys = entries.map(e => e.idempotencyKey)

        let outcomes: SyncPushOutcome[]
        try {
            outcomes = await this.deps.transport.pushWrites({
                entries,
                meta,
                returning: this.deps.returning,
                signal
            })
        } catch (error) {
            await this.deps.outbox.commit({ ack: [], reject: [], retryable: keys })
            if (signal.aborted) throw new AbortError('[Sync] push stopped')
            throw new RetryableSyncError(toError(error))
        }

        if (outcomes.length !== entries.length) {
            await this.deps.outbox.commit({ ack: [], reject: [], retryable: keys })
            throw new Error(`[Sync] transport.pushWrites returned outcomes.length=${outcomes.length}, expected=${entries.length}`)
        }

        if (this.disposed || !this.enabled || this.runId !== runId || signal.aborted) {
            await this.deps.outbox.commit({ ack: [], reject: [], retryable: keys })
            throw new AbortError('[Sync] push stopped')
        }

        const acks: SyncWriteAck[] = []
        const rejects: SyncWriteReject[] = []
        const ackedKeys: string[] = []
        const rejectedKeys: string[] = []
        const retryableKeys: string[] = []

        const rebaseById = new Map<string, { resource: string; id: string; baseVersion: number; afterEnqueuedAtMs: number }>()
        let retryError: Error | undefined

        for (let i = 0; i < outcomes.length; i++) {
            if (this.disposed || !this.enabled || this.runId !== runId || signal.aborted) {
                await this.deps.outbox.commit({ ack: [], reject: [], retryable: keys })
                throw new AbortError('[Sync] push stopped')
            }

            const outcome = outcomes[i]!
            const entry = entries[i]!

            if (outcome.kind === 'retry') {
                retryableKeys.push(entry.idempotencyKey)
                retryError = retryError ?? toError(outcome.error)
                continue
            }

            if (outcome.kind === 'ack') {
                acks.push({
                    resource: entry.resource,
                    entry: entry.entry as any,
                    result: outcome.result
                })
                ackedKeys.push(entry.idempotencyKey)

                const id = outcome.result.id
                const version = outcome.result.version
                if (Number.isFinite(version) && version > 0) {
                    const existing = rebaseById.get(id)
                    const afterEnqueuedAtMs = entry.enqueuedAtMs
                    if (!existing || afterEnqueuedAtMs > existing.afterEnqueuedAtMs) {
                        rebaseById.set(id, {
                            resource: entry.resource,
                            id,
                            baseVersion: version,
                            afterEnqueuedAtMs
                        })
                    }
                }
                continue
            }

            rejects.push({
                resource: entry.resource,
                entry: entry.entry as any,
                result: outcome.result
            })
            rejectedKeys.push(entry.idempotencyKey)
        }

        // Apply results first, then commit the outbox.
        // If apply fails midway, commit only what was successfully applied to avoid double-apply on next drain.
        try {
            if ((this.deps.applier as any).atomicBatchApply === true && typeof (this.deps.applier as any).applyWriteResults === 'function') {
                await Promise.resolve((this.deps.applier as any).applyWriteResults({
                    acks,
                    rejects,
                    signal
                }))
            } else {
                const appliedAcked: string[] = []
                const appliedRejected: string[] = []

                for (let i = 0; i < acks.length; i++) {
                    if (signal.aborted) throw new AbortError('[Sync] push stopped')
                    await Promise.resolve(this.deps.applier.applyWriteAck(acks[i]!))
                    appliedAcked.push(ackedKeys[i]!)
                }
                for (let i = 0; i < rejects.length; i++) {
                    if (signal.aborted) throw new AbortError('[Sync] push stopped')
                    await Promise.resolve(this.deps.applier.applyWriteReject(rejects[i]!))
                    appliedRejected.push(rejectedKeys[i]!)
                }

                // Replace full lists with applied subsets (they should be identical here).
                ackedKeys.length = 0
                rejectedKeys.length = 0
                ackedKeys.push(...appliedAcked)
                rejectedKeys.push(...appliedRejected)
            }
        } catch (error) {
            const appliedAckSet = new Set(ackedKeys)
            const appliedRejectSet = new Set(rejectedKeys)

            // Anything not applied must be released back to pending to avoid losing it.
            const applied = [...appliedAckSet, ...appliedRejectSet]
            const remaining = keys.filter(k => !appliedAckSet.has(k) && !appliedRejectSet.has(k))

            await this.deps.outbox.commit({
                ack: applied,
                reject: [],
                retryable: [...retryableKeys, ...remaining]
            })
            throw error
        }

        await this.deps.outbox.commit({
            ack: ackedKeys,
            reject: rejectedKeys,
            retryable: retryableKeys,
            rebase: Array.from(rebaseById.values())
        })

        if (retryableKeys.length) {
            throw new RetryableSyncError(retryError ?? new Error('RETRYABLE'))
        }

        return 'continue'
    }
}
