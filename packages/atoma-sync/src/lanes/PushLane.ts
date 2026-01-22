import pRetry, { AbortError } from 'p-retry'
import PQueue from 'p-queue'
import debounce from 'p-debounce'
import { toError } from '#sync/internal'
import { estimateDelayFromRetryContext, resolveRetryOptions } from '#sync/policies/retryPolicy'
import type { OutboxReader, SyncApplier, SyncEvent, SyncOutboxItem, SyncPhase, SyncPushOutcome, SyncTransport, SyncWriteAck, SyncWriteReject } from '#sync/types'

export class PushLane {
    private disposed = false
    private enabled = true
    private readonly queue = new PQueue({ concurrency: 1 })
    private readonly retryOptions: ReturnType<typeof resolveRetryOptions>
    private readonly scheduleDrain: () => Promise<void>
    
    constructor(private readonly deps: {
        outbox: OutboxReader
        transport: SyncTransport
        applier: SyncApplier
        maxPushItems: number
        returning: boolean
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
        retry?: { maxAttempts?: number }
        backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
        now: () => number
        buildMeta: () => any
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: SyncEvent) => void
    }) {
        this.retryOptions = resolveRetryOptions({
            retry: deps.retry,
            backoff: deps.backoff,
            unref: true
        })

        // Coalesce flush requests:
        // - concurrent calls share the same promise
        // - if requests happen while draining, run one more time after the current drain completes
        this.scheduleDrain = debounce.promise(async () => {
            if (this.disposed || !this.enabled) return
            await this.queue.add(() => this.runDrain())
        }, { after: true })
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.enabled = false
        this.queue.clear()
        this.queue.pause()
    }

    setEnabled(enabled: boolean) {
        if (this.disposed) return
        this.enabled = Boolean(enabled)
        if (!this.enabled) {
            this.queue.clear()
            this.queue.pause()
        } else {
            this.queue.start()
        }
    }

    requestFlush() {
        if (this.disposed) return
        if (!this.enabled) return
        void this.scheduleDrain().catch(() => {
            // errors are reported inside the drain flow
        })
    }

    flush(): Promise<void> {
        if (this.disposed) return Promise.resolve()
        if (!this.enabled) return Promise.resolve()
        void this.requestFlush()
        return this.queue.onIdle()
    }

    private async runDrain(): Promise<void> {
        if (this.disposed || !this.enabled) return
        this.deps.onEvent?.({ type: 'push:start' })
        try {
            await this.drainUntilIdle()
        } finally {
            this.deps.onEvent?.({ type: 'push:idle' })
        }
    }

    private async drainUntilIdle(): Promise<void> {
        while (!this.disposed && this.enabled) {
            try {
                const result = await pRetry(() => this.flushBatchOnce(), {
                    ...this.retryOptions,
                    onFailedAttempt: (ctx) => {
                        const delayMs = estimateDelayFromRetryContext(ctx, this.retryOptions)
                        this.deps.onEvent?.({ type: 'push:backoff', attempt: ctx.attemptNumber, delayMs })
                    },
                    shouldRetry: (ctx) => !(ctx.error instanceof AbortError)
                })

                if (result === 'idle') return
            } catch (error) {
                // Retry budget exhausted (or aborted). Mirror the old behavior: stop this drain cycle.
                if (!(error instanceof AbortError)) {
                    this.deps.onError?.(toError(error), { phase: 'push' })
                }
                return
            }
        }
    }

    private async flushBatchOnce(): Promise<'idle' | 'continue'> {
        if (this.disposed || !this.enabled) {
            throw new AbortError('[Sync] push stopped')
        }

        const max = Math.max(1, Math.floor(this.deps.maxPushItems))
        const entries = await this.deps.outbox.peek(max)
        if (!entries.length) return 'idle'

        const meta = this.deps.buildMeta()

        const keys = entries.map(e => e.idempotencyKey)
        await Promise.resolve(this.deps.outbox.markInFlight?.(keys, this.deps.now()))

        let outcomes: SyncPushOutcome[]
        try {
            outcomes = await this.deps.transport.pushWrites({
                entries,
                meta,
                returning: this.deps.returning
            })
        } catch (error) {
            const err = toError(error)
            await Promise.resolve(this.deps.outbox.releaseInFlight?.(keys))
            throw err
        }

        if (outcomes.length !== entries.length) {
            await Promise.resolve(this.deps.outbox.releaseInFlight?.(keys))
            throw new Error(`[Sync] transport.pushWrites returned outcomes.length=${outcomes.length}, expected=${entries.length}`)
        }

        const acked: string[] = []
        const rejected: string[] = []
        const retryable: string[] = []
        const rebaseByEntityId = new Map<string, { resource: string; entityId: string; baseVersion: number; afterEnqueuedAtMs: number }>()
        let retryError: Error | undefined

        try {
            for (let i = 0; i < outcomes.length; i++) {
                const outcome = outcomes[i]
                const entry = entries[i]
                if (outcome.kind === 'retry') {
                    retryable.push(entry.idempotencyKey)
                    retryError = retryError ?? toError(outcome.error)
                    continue
                }

                if (outcome.kind === 'ack') {
                    const ack: SyncWriteAck = {
                        resource: entry.resource,
                        action: entry.action as any,
                        item: entry.item as any,
                        result: outcome.result
                    }
                    await Promise.resolve(this.deps.applier.applyWriteAck(ack))
                    acked.push(entry.idempotencyKey)

                    const entityId = outcome.result.entityId
                    const version = outcome.result.version
                    if (Number.isFinite(version) && version > 0) {
                        const existing = rebaseByEntityId.get(entityId)
                        const afterEnqueuedAtMs = entry.enqueuedAtMs
                        if (!existing || afterEnqueuedAtMs > existing.afterEnqueuedAtMs) {
                            rebaseByEntityId.set(entityId, {
                                resource: entry.resource,
                                entityId,
                                baseVersion: version,
                                afterEnqueuedAtMs
                            })
                        }
                    }
                    continue
                }

                const reject: SyncWriteReject = {
                    resource: entry.resource,
                    action: entry.action as any,
                    item: entry.item as any,
                    result: outcome.result
                }
                await Promise.resolve(this.deps.applier.applyWriteReject(reject, this.deps.conflictStrategy))
                rejected.push(entry.idempotencyKey)
            }

            await this.deps.outbox.ack(acked)
            await this.deps.outbox.reject(rejected)
            if (retryable.length) {
                await Promise.resolve(this.deps.outbox.releaseInFlight?.(retryable))
            }

            for (const rebase of rebaseByEntityId.values()) {
                await Promise.resolve(this.deps.outbox.rebase?.(rebase))
            }
        } catch (error) {
            await Promise.resolve(this.deps.outbox.releaseInFlight?.(keys))
            throw error
        }

        if (retryable.length) throw (retryError ?? new Error('RETRYABLE'))

        return 'continue'
    }
}
