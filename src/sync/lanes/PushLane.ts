import { buildWriteBatchCompacted } from '../policies/batchPolicy'
import type { OutboxStore, SyncApplier, SyncEvent, SyncOutboxItem, SyncPhase, SyncTransport, SyncWriteAck, SyncWriteReject } from '../types'
import type {
    Meta,
    Operation,
    OperationResult,
    StandardError,
    WriteItemResult,
    WriteResultData
} from '#protocol'
import { sleepMs } from '../policies/backoffPolicy'
import { executeSingleOp, toError } from '../internal'
import { RetryBackoff } from '../policies/retryBackoff'

export class PushLane {
    private disposed = false
    private enabled = true
    private pushing = false
    private flushScheduled = false
    private flushRequested = false
    private readonly retry: RetryBackoff

    constructor(private readonly deps: {
        outbox: OutboxStore
        transport: SyncTransport
        applier: SyncApplier
        maxPushItems: number
        returning: boolean
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
        retry?: { maxAttempts?: number }
        backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
        now: () => number
        buildMeta: () => Meta
        nextOpId: (prefix: 'w') => string
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: SyncEvent) => void
    }) {
        this.retry = new RetryBackoff({
            retry: deps.retry,
            backoff: deps.backoff
        })
    }

    dispose() {
        this.disposed = true
    }

    setEnabled(enabled: boolean) {
        if (this.disposed) return
        this.enabled = Boolean(enabled)
    }

    requestFlush() {
        if (this.disposed) return
        if (!this.enabled) return
        if (this.flushScheduled) return
        this.flushScheduled = true
        queueMicrotask(() => {
            this.flushScheduled = false
            void this.flush()
        })
    }

    async flush() {
        if (this.disposed) return
        if (!this.enabled) return
        if (this.pushing) {
            this.flushRequested = true
            return
        }

        this.pushing = true
        this.deps.onEvent?.({ type: 'push:start' })
        try {
            while (!this.disposed) {
                const batch = await this.peekWriteBatch()
                if (!batch) break

                const { resource, action, items, entries, representedEntries } = batch
                const represented = representedEntries && Array.isArray(representedEntries) && representedEntries.length === entries.length
                    ? representedEntries
                    : entries.map(e => [e])
                const allEntries: SyncOutboxItem[] = represented.flat()
                const keys = allEntries.map(e => e.idempotencyKey)
                const opId = this.deps.nextOpId('w')
                const meta = this.deps.buildMeta()

                try {
                    await Promise.resolve(this.deps.outbox.markInFlight?.(keys, this.deps.now()))

                    const baseOptions = batch.options && typeof batch.options === 'object'
                        ? batch.options
                        : undefined

                    const op: Operation = {
                        opId,
                        kind: 'write',
                        write: {
                            resource,
                            action,
                            items,
                            options: {
                                ...(baseOptions ? baseOptions : {}),
                                returning: this.deps.returning
                            }
                        }
                    }

                    const opResult = await executeSingleOp({
                        transport: this.deps.transport,
                        op,
                        meta
                    })

                    if (!opResult.ok) {
                        if (isRetryableOpError(opResult.error as any)) {
                            const stop = await this.retryBackoff()
                            await Promise.resolve(this.deps.outbox.releaseInFlight?.(keys))
                            if (stop) break
                            continue
                        }
                        const rejected = await this.rejectAllFromOpError(opResult, allEntries)
                        await this.deps.outbox.reject(rejected)
                        this.retry.reset()
                        continue
                    }

                    const writeData = opResult.data as WriteResultData
                    const mapped = indexWriteResults(writeData.results)
                    const acked: string[] = []
                    const rejected: string[] = []
                    const rebaseByEntityId = new Map<string, { resource: string; entityId: string; baseVersion: number; afterEnqueuedAtMs: number }>()

                    for (let i = 0; i < entries.length; i++) {
                        const outboxItem = entries[i]
                        const covered = represented[i] ?? [outboxItem]
                        const res = mapped.get(i)
                        if (res && res.ok === true) {
                            for (const coveredItem of covered) {
                                const ack: SyncWriteAck = {
                                    resource,
                                    action,
                                    item: coveredItem.item,
                                    result: res
                                }
                                await Promise.resolve(this.deps.applier.applyWriteAck(ack))
                                acked.push(coveredItem.idempotencyKey)
                            }

                            const entityId = String(res.entityId)
                            const version = res.version
                            if (typeof version === 'number' && Number.isFinite(version) && version > 0) {
                                const existing = rebaseByEntityId.get(entityId)
                                const afterEnqueuedAtMs = outboxItem.enqueuedAtMs
                                if (!existing || afterEnqueuedAtMs > existing.afterEnqueuedAtMs) {
                                    rebaseByEntityId.set(entityId, {
                                        resource,
                                        entityId,
                                        baseVersion: version,
                                        afterEnqueuedAtMs
                                    })
                                }
                            }
                            continue
                        }

                        const rejectRes = (res && res.ok === false)
                            ? res
                            : {
                                index: i,
                                ok: false as const,
                                error: { code: 'WRITE_FAILED', message: 'Missing write item result', kind: 'internal' as const }
                        }
                        for (const coveredItem of covered) {
                            const reject: SyncWriteReject = {
                                resource,
                                action,
                                item: coveredItem.item,
                                result: rejectRes
                            }
                            await Promise.resolve(this.deps.applier.applyWriteReject(reject, this.deps.conflictStrategy))
                            rejected.push(coveredItem.idempotencyKey)
                        }
                    }

                    await this.deps.outbox.ack(acked)
                    await this.deps.outbox.reject(rejected)

                    for (const rebase of rebaseByEntityId.values()) {
                        await Promise.resolve(this.deps.outbox.rebase?.(rebase))
                    }
                    this.retry.reset()
                } catch (error) {
                    const err = toError(error)
                    this.deps.onError?.(err, { phase: 'push' })
                    await Promise.resolve(this.deps.outbox.releaseInFlight?.(keys))
                    const stop = await this.retryBackoff()
                    if (stop) break
                }
            }
        } finally {
            this.pushing = false
            this.deps.onEvent?.({ type: 'push:idle' })
            if (this.flushRequested) {
                this.flushRequested = false
                this.requestFlush()
            }
        }
    }

    private async peekWriteBatch() {
        const max = Math.max(1, Math.floor(this.deps.maxPushItems))
        const scan = Math.min(5000, Math.max(max, max * 20))
        const pending = await this.deps.outbox.peek(scan)
        return buildWriteBatchCompacted(pending, max)
    }

    private async retryBackoff(): Promise<boolean> {
        const { attempt, delayMs, stop } = this.retry.next()
        if (stop) return true
        if (!delayMs) return false
        this.deps.onEvent?.({ type: 'push:backoff', attempt, delayMs })
        await sleepMs(delayMs)
        if (!this.disposed) {
            this.deps.onEvent?.({ type: 'push:start' })
        }
        return false
    }

    private async rejectAllFromOpError(result: OperationResult, entries: SyncOutboxItem[]): Promise<string[]> {
        if (result.ok) return []
        const rejected: string[] = []
        for (let i = 0; i < entries.length; i++) {
            const outboxItem = entries[i]
            const reject: SyncWriteReject = {
                resource: outboxItem.resource,
                action: outboxItem.action,
                item: outboxItem.item,
                result: {
                    index: i,
                    ok: false,
                    error: result.error
                } as any
            }
            await Promise.resolve(this.deps.applier.applyWriteReject(reject, this.deps.conflictStrategy))
            rejected.push(outboxItem.idempotencyKey)
        }
        return rejected
    }
}

function indexWriteResults(results: WriteItemResult[]) {
    const map = new Map<number, WriteItemResult>()
    for (const res of results) {
        if (typeof res.index === 'number' && Number.isFinite(res.index)) {
            map.set(res.index, res)
        }
    }
    return map
}

function isRetryableOpError(error: StandardError | null | undefined): boolean {
    if (!error || typeof error !== 'object') return false
    if (error.retryable === true) return true
    const kind = error.kind
    return kind === 'internal' || kind === 'adapter'
}
