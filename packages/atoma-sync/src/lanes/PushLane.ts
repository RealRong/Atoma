import pRetry, { AbortError } from 'p-retry'
import PQueue from 'p-queue'
import { type Meta, type OperationResult, type WriteItemResult, type WriteResultData } from 'atoma/protocol'
import { findOpResult, toError } from '../internal'
import { ensureOutboxWriteOp, readOutboxWrite } from '../outboxSpec'
import { estimateDelayFromRetryContext, resolveRetryOptions } from '../policies/retryPolicy'
import type { OutboxReader, SyncApplier, SyncEvent, SyncOutboxItem, SyncPhase, SyncTransport, SyncWriteAck, SyncWriteReject } from '../types'

export class PushLane {
    private disposed = false
    private enabled = true
    private drainQueued = false
    private drainRequested = false
    private readonly queue = new PQueue({ concurrency: 1 })
    private readonly retryOptions: ReturnType<typeof resolveRetryOptions>

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
        buildMeta: () => Meta
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: SyncEvent) => void
    }) {
        this.retryOptions = resolveRetryOptions({
            retry: deps.retry,
            backoff: deps.backoff,
            unref: true
        })
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.enabled = false
        this.drainRequested = false
        this.drainQueued = false
        this.queue.clear()
        this.queue.pause()
    }

    setEnabled(enabled: boolean) {
        if (this.disposed) return
        this.enabled = Boolean(enabled)
        if (!this.enabled) {
            this.drainRequested = false
            this.drainQueued = false
            this.queue.clear()
            this.queue.pause()
        } else {
            this.queue.start()
            if (this.drainRequested) {
                this.requestFlush()
            }
        }
    }

    requestFlush() {
        if (this.disposed) return
        if (!this.enabled) return
        this.drainRequested = true
        this.enqueueDrain()
    }

    flush(): Promise<void> {
        if (this.disposed) return Promise.resolve()
        if (!this.enabled) return Promise.resolve()
        this.drainRequested = true
        this.enqueueDrain()
        return this.queue.onIdle()
    }

    private enqueueDrain() {
        if (this.disposed) return
        if (!this.enabled) return
        if (this.drainQueued) return
        this.drainQueued = true
        void this.queue.add(async () => {
            this.deps.onEvent?.({ type: 'push:start' })
            try {
                while (!this.disposed && this.enabled) {
                    if (!this.drainRequested) return
                    // Consume the request flag; if new requests arrive while draining, they set it back to true.
                    this.drainRequested = false
                    await this.drainUntilIdle()
                }
            } finally {
                this.deps.onEvent?.({ type: 'push:idle' })
            }
        }).finally(() => {
            this.drainQueued = false
            if (this.drainRequested && !this.disposed && this.enabled) {
                this.enqueueDrain()
            }
        })
    }

    private async drainUntilIdle(): Promise<void> {
        while (!this.disposed && this.enabled) {
            try {
                const result = await pRetry((attemptNumber) => this.flushBatchOnce(attemptNumber), {
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

    private async flushBatchOnce(attemptNumber: number): Promise<'idle' | 'continue'> {
        if (this.disposed || !this.enabled) {
            throw new AbortError('[Sync] push stopped')
        }

        if (attemptNumber > 1) {
            // New attempt after a backoff delay.
            this.deps.onEvent?.({ type: 'push:start' })
        }

        const max = Math.max(1, Math.floor(this.deps.maxPushItems))
        const entries = await this.deps.outbox.peek(max)
        if (!entries.length) return 'idle'

        const keys = entries.map(e => e.idempotencyKey)
        const meta = this.deps.buildMeta()

        await Promise.resolve(this.deps.outbox.markInFlight?.(keys, this.deps.now()))

        let mapped: Array<{ entry: SyncOutboxItem; write: ReturnType<typeof readOutboxWrite>; op: any }>
        try {
            mapped = entries.map(entry => ({
                entry,
                write: readOutboxWrite(entry),
                op: ensureOutboxWriteOp({ entry, returning: this.deps.returning })
            }))
        } catch (error) {
            const err = toError(error)
            this.deps.onError?.(err, { phase: 'push' })
            await Promise.resolve(this.deps.outbox.releaseInFlight?.(keys))
            await this.deps.outbox.reject(keys, err)
            return 'continue'
        }
        const opsToSend = mapped.map(m => m.op)

        let res: { results: OperationResult[] }
        try {
            res = await this.deps.transport.opsClient.executeOps({ ops: opsToSend, meta })
        } catch (error) {
            const err = toError(error)
            await Promise.resolve(this.deps.outbox.releaseInFlight?.(keys))
            throw err
        }

        const acked: string[] = []
        const rejected: string[] = []
        const retryable: string[] = []
        const rebaseByEntityId = new Map<string, { resource: string; entityId: string; baseVersion: number; afterEnqueuedAtMs: number }>()

        for (const m of mapped) {
            const op = m.op
            const entry = m.entry
            const write = m.write
            const result = findOpResult(res.results, op.opId)

            if (!result) {
                const reject: SyncWriteReject = {
                    resource: write.resource,
                    action: write.action,
                    item: write.item,
                    result: {
                        index: 0,
                        ok: false,
                        error: { code: 'WRITE_FAILED', message: 'Missing write result', kind: 'internal' as const }
                    } as any
                }
                await Promise.resolve(this.deps.applier.applyWriteReject(reject, this.deps.conflictStrategy))
                rejected.push(entry.idempotencyKey)
                continue
            }

            if (!result.ok) {
                if (isRetryableOpError(result.error)) {
                    retryable.push(entry.idempotencyKey)
                    continue
                }

                const reject: SyncWriteReject = {
                    resource: write.resource,
                    action: write.action,
                    item: write.item,
                    result: {
                        index: 0,
                        ok: false,
                        error: result.error
                    } as any
                }
                await Promise.resolve(this.deps.applier.applyWriteReject(reject, this.deps.conflictStrategy))
                rejected.push(entry.idempotencyKey)
                continue
            }

            const data = result.data as WriteResultData
            const itemResults = Array.isArray(data?.results) ? data.results : []
            const itemResult = (itemResults.length ? itemResults[0] : undefined) as (WriteItemResult | undefined)

            if (itemResult && itemResult.ok === true) {
                const ack: SyncWriteAck = {
                    resource: write.resource,
                    action: write.action,
                    item: write.item,
                    result: itemResult as any
                }
                await Promise.resolve(this.deps.applier.applyWriteAck(ack))
                acked.push(entry.idempotencyKey)

                const entityId = String((itemResult as any).entityId)
                const version = (itemResult as any).version
                if (typeof version === 'number' && Number.isFinite(version) && version > 0) {
                    const existing = rebaseByEntityId.get(entityId)
                    const afterEnqueuedAtMs = entry.enqueuedAtMs
                    if (!existing || afterEnqueuedAtMs > existing.afterEnqueuedAtMs) {
                        rebaseByEntityId.set(entityId, {
                            resource: write.resource,
                            entityId,
                            baseVersion: version,
                            afterEnqueuedAtMs
                        })
                    }
                }
                continue
            }

            const rejectRes = (itemResult && itemResult.ok === false)
                ? itemResult
                : {
                    index: 0,
                    ok: false as const,
                    error: { code: 'WRITE_FAILED', message: 'Missing write item result', kind: 'internal' as const }
                }

            const reject: SyncWriteReject = {
                resource: write.resource,
                action: write.action,
                item: write.item,
                result: rejectRes as any
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

        if (retryable.length) {
            throw new Error('RETRYABLE')
        }

        return 'continue'
    }
}

function isRetryableOpError(error: any): boolean {
    if (!error || typeof error !== 'object') return false
    if (error.retryable === true) return true
    const kind = error.kind
    return kind === 'internal' || kind === 'adapter'
}
