import type { OutboxStore, SyncApplier, SyncEvent, SyncOutboxItem, SyncPhase, SyncTransport, SyncWriteAck, SyncWriteReject } from '../types'
import { Protocol, type Meta, type Operation, type OperationResult, type StandardError, type WriteAction, type WriteItem, type WriteItemResult, type WriteResultData } from '#protocol'
import { sleepMs } from '../policies/backoffPolicy'
import { findOpResult, toError } from '../internal'
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
                const entries = await this.peekOutboxItems()
                if (!entries.length) break

                const keys = entries.map(e => e.idempotencyKey)
                const meta = this.deps.buildMeta()

                try {
                    await Promise.resolve(this.deps.outbox.markInFlight?.(keys, this.deps.now()))

                    const mapped = entries.map(entry => ({
                        entry,
                        write: readOutboxWrite(entry),
                        op: ensureOutboxWriteOp({
                            entry,
                            returning: this.deps.returning
                        })
                    }))
                    const opsToSend = mapped.map(m => m.op)

                    try {
                        Protocol.ops.validate.assertOutgoingOpsV1({ ops: opsToSend, meta })
                    } catch (error) {
                        const maybeStandard = (error && typeof error === 'object' && typeof (error as any).code === 'string' && typeof (error as any).message === 'string' && typeof (error as any).kind === 'string')
                            ? (error as any as StandardError)
                            : {
                                code: 'INVALID_WRITE',
                                message: error instanceof Error ? error.message : `Invalid outbox write: ${String(error)}`,
                                kind: 'validation' as const
                            }
                        const rejected = await this.rejectAllFromOpError({ opId: 'validation', ok: false, error: maybeStandard }, entries)
                        await this.deps.outbox.reject(rejected, maybeStandard)
                        this.retry.reset()
                        continue
                    }

                    let res: { results: OperationResult[] }
                    try {
                        res = await this.deps.transport.opsClient.executeOps({ ops: opsToSend, meta })
                    } catch (error) {
                        const err = toError(error)
                        this.deps.onError?.(err, { phase: 'push' })
                        await Promise.resolve(this.deps.outbox.releaseInFlight?.(keys))
                        const stop = await this.retryBackoff()
                        if (stop) break
                        continue
                    }

                    const acked: string[] = []
                    const rejected: string[] = []
                    const retryable: string[] = []
                    const rebaseByEntityId = new Map<string, { resource: string; entityId: string; baseVersion: number; afterEnqueuedAtMs: number }>()

                    for (const m of mapped) {
                        const entry = m.entry
                        const write = m.write
                        const result = findOpResult(res.results, m.op.opId)

                        if (!result.ok) {
                            if (isRetryableOpError(result.error as any)) {
                                retryable.push(entry.idempotencyKey)
                                continue
                            }

                            const reject: SyncWriteReject = {
                                resource: write.resource,
                                action: write.action,
                                item: write.item,
                                result: {
                                    index: 0,
                                    ok: false as const,
                                    error: result.error
                                } as any
                            }
                            await Promise.resolve(this.deps.applier.applyWriteReject(reject, this.deps.conflictStrategy))
                            rejected.push(entry.idempotencyKey)
                            continue
                        }

                        const writeData = result.data as WriteResultData
                        const itemResult = Array.isArray((writeData as any)?.results) ? ((writeData as any).results[0] as WriteItemResult | undefined) : undefined
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
                        const stop = await this.retryBackoff()
                        if (stop) break
                        continue
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

    private async peekOutboxItems(): Promise<SyncOutboxItem[]> {
        const max = Math.max(1, Math.floor(this.deps.maxPushItems))
        return await this.deps.outbox.peek(max)
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
            const write = readOutboxWrite(outboxItem)
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
            rejected.push(outboxItem.idempotencyKey)
        }
        return rejected
    }
}

function readOutboxWrite(entry: SyncOutboxItem): { opId: string; resource: string; action: WriteAction; item: WriteItem; options?: any } {
    const op: any = (entry as any).op
    if (!op || op.kind !== 'write') throw new Error('[Sync] outbox entry must contain write op')
    const write: any = op.write
    const resource = String(write?.resource ?? '')
    const action = write?.action as WriteAction
    const item = (Array.isArray(write?.items) ? write.items[0] : undefined) as WriteItem | undefined
    if (!resource || !action || !item) throw new Error('[Sync] invalid outbox write op')
    const options = (write?.options && typeof write.options === 'object') ? write.options : undefined
    return { opId: String(op.opId), resource, action, item, ...(options ? { options } : {}) }
}

function ensureOutboxWriteOp(args: { entry: SyncOutboxItem; returning: boolean }): Operation {
    const write = readOutboxWrite(args.entry)
    const meta = (write.item as any)?.meta
    if (!meta || typeof meta !== 'object' || typeof (meta as any).idempotencyKey !== 'string' || !(meta as any).idempotencyKey) {
        throw new Error('[Sync] outbox write item meta.idempotencyKey is required')
    }
    if ((meta as any).idempotencyKey !== args.entry.idempotencyKey) {
        throw new Error('[Sync] outbox entry idempotencyKey must match write item meta.idempotencyKey')
    }

    const options = write.options && typeof write.options === 'object' ? write.options : undefined
    const ensuredOptions = {
        ...(options ? options : {}),
        returning: args.returning
    }

    return Protocol.ops.build.buildWriteOp({
        opId: write.opId,
        write: {
            resource: write.resource,
            action: write.action,
            items: [write.item],
            options: ensuredOptions
        }
    })
}

function isRetryableOpError(error: StandardError | null | undefined): boolean {
    if (!error || typeof error !== 'object') return false
    if (error.retryable === true) return true
    const kind = error.kind
    return kind === 'internal' || kind === 'adapter'
}
