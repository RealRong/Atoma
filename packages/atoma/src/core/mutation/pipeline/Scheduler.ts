/**
 * Mutation Pipeline: Scheduler
 * Purpose: Queues dispatch events, normalizes opContext, segments by context, and drains in microtasks.
 * Call chain: MutationPipeline.api.dispatch -> Scheduler.enqueue -> Scheduler.executeSegment -> executeMutationFlow.
 */
import { toErrorWithFallback } from '#shared'
import type { PrimitiveAtom } from 'jotai/vanilla'
import type { StoreDispatchEvent } from '../../types'
import { createActionId, normalizeOperationContext } from '../../operationContext'
import type { OperationContext } from '../../types'
import type { MutationCommitInfo, MutationSegment } from './types'

type AtomKey = PrimitiveAtom<any>

function opContextSegmentKey(op: StoreDispatchEvent<any>) {
    const c = op.opContext
    const persist = op.writeStrategy ?? ''
    return `${c?.scope ?? 'default'}|${c?.origin ?? 'user'}|${c?.actionId ?? ''}|${persist}`
}

export class Scheduler {
    constructor(
        private readonly deps: {
            run: (args: MutationSegment<any>) => Promise<MutationCommitInfo | null | void>
        }
    ) { }

    private scheduled = false
    private draining = false
    private queueMap = new Map<AtomKey, Array<StoreDispatchEvent<any>>>()
    private readonly autoActionIdByKey = new Map<string, { actionId: string; timestamp: number }>()

    enqueue(event: StoreDispatchEvent<any>) {
        const atom = event.handle.atom
        const existing = this.queueMap.get(atom)
        if (existing) {
            existing.push(event)
        } else {
            this.queueMap.set(atom, [event])
        }

        this.scheduleDrain()
    }

    scheduleDrain() {
        if (this.scheduled) return
        this.scheduled = true
        queueMicrotask(() => {
            this.scheduled = false
            void this.drainLoop()
        })
    }

    drainSync() {
        this.scheduled = false
        void this.drainLoop()
    }

    private async drainLoop() {
        if (this.draining) return
        this.draining = true
        try {
            while (this.queueMap.size) {
                const snapshot = new Map(this.queueMap)
                this.queueMap.clear()

                for (const [_atom, events] of snapshot.entries()) {
                    if (!events.length) continue
                    const processed = this.normalizeDispatchEvents(events)
                    if (!processed.length) continue

                    const segments = this.segmentByOpContext(processed)
                    for (const ops of segments) {
                        await this.executeSegment(ops)
                    }
                }
            }
        } finally {
            this.draining = false
            this.autoActionIdByKey.clear()
        }
    }

    private normalizeDispatchEvents(events: Array<StoreDispatchEvent<any>>) {
        const processed: Array<StoreDispatchEvent<any>> = []

        for (const original of events) {
            try {
                const normalizedOpContext = this.normalizeOpContext(original.opContext)
                const normalized = {
                    ...original,
                    opContext: normalizedOpContext
                } as StoreDispatchEvent<any>

                processed.push(normalized)
            } catch (error) {
                const err = toErrorWithFallback(error, '[Atoma] dispatch failed')
                original.ticket?.settle('enqueued', err)
                original.onFail?.(err)
            }
        }

        return processed
    }

    private segmentByOpContext(events: Array<StoreDispatchEvent<any>>) {
        const segments: Array<Array<StoreDispatchEvent<any>>> = []
        let current: Array<StoreDispatchEvent<any>> = []
        let currentKey: string | undefined

        events.forEach((op) => {
            const key = opContextSegmentKey(op)
            if (!current.length) {
                current = [op]
                currentKey = key
                return
            }
            if (key === currentKey) {
                current.push(op)
                return
            }
            segments.push(current)
            current = [op]
            currentKey = key
        })
        if (current.length) segments.push(current)

        return segments
    }

    private async executeSegment(ops: Array<StoreDispatchEvent<any>>) {
        const handle = ops[0].handle

        const baseOpContext = ops[0].opContext
        const segmentOpContext = normalizeOperationContext(baseOpContext)

        const segmentOps: Array<StoreDispatchEvent<any>> = ops.map(op => ({ ...op, opContext: segmentOpContext }))

        await this.deps.run({ handle, operations: segmentOps, opContext: segmentOpContext })
    }

    private normalizeOpContext(ctx: OperationContext | undefined) {
        if (typeof ctx?.actionId === 'string' && ctx.actionId) {
            return normalizeOperationContext(ctx)
        }

        const scope = typeof ctx?.scope === 'string' && ctx.scope ? ctx.scope : 'default'
        const origin = ctx?.origin ?? 'user'
        const key = `${scope}|${origin}`

        const existing = this.autoActionIdByKey.get(key)
        const entry = existing ?? (() => {
            const next = { actionId: createActionId(), timestamp: Date.now() }
            this.autoActionIdByKey.set(key, next)
            return next
        })()

        return normalizeOperationContext({
            scope,
            origin,
            actionId: entry.actionId,
            label: ctx?.label,
            timestamp: typeof ctx?.timestamp === 'number' ? ctx.timestamp : entry.timestamp
        })
    }
}
