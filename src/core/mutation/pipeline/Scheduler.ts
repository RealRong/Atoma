import type { PrimitiveAtom } from 'jotai/vanilla'
import type { StoreDispatchEvent } from '../../types'
import { normalizeOperationContext } from '../../operationContext'
import type { IExecutor } from './types'
import type { VersionManager } from './VersionManager'
import type { BeforeDispatchContext, DispatchDecision, PlannedEvent } from '../hooks'

type AtomKey = PrimitiveAtom<any>

function segmentKey(op: StoreDispatchEvent<any>) {
    const c = op.opContext
    return `${c?.scope ?? 'default'}|${c?.origin ?? 'user'}|${c?.actionId ?? ''}`
}

function toError(reason: unknown, fallbackMessage: string): Error {
    if (reason instanceof Error) return reason
    if (typeof reason === 'string' && reason) return new Error(reason)
    try {
        return new Error(`${fallbackMessage}: ${JSON.stringify(reason)}`)
    } catch {
        return new Error(fallbackMessage)
    }
}

export class Scheduler {
    constructor(
        private readonly deps: {
            executor: IExecutor
            versionTracker: VersionManager
        }
    ) { }

    private scheduled = false
    private draining = false
    private queueMap = new Map<AtomKey, Array<StoreDispatchEvent<any>>>()

    enqueue(event: StoreDispatchEvent<any>) {
        const run = async () => {
            const services = event.handle.services
            const hooks = services.mutation.hooks

            const decision: DispatchDecision<StoreDispatchEvent<any>> = await hooks.middleware.beforeDispatch.run(
                {
                    storeName: event.handle.storeName,
                    event
                } as BeforeDispatchContext<any>,
                async () => ({ kind: 'proceed' } as any)
            )

            if (decision.kind === 'reject') {
                const err = toError(decision.error, '[Atoma] dispatch rejected')
                event.ticket?.settle('enqueued', err)
                event.onFail?.(err)
                return
            }

            const nextEvent = decision.kind === 'transform'
                ? (decision.event as StoreDispatchEvent<any>)
                : event

            const normalized = {
                ...nextEvent,
                opContext: normalizeOperationContext(nextEvent.opContext)
            } as StoreDispatchEvent<any>

            const atom = normalized.handle.atom as any
            const existing = this.queueMap.get(atom)
            if (existing) {
                existing.push(normalized)
            } else {
                this.queueMap.set(atom, [normalized])
            }

            this.flush()
        }

        void run().catch((error) => {
            const err = toError(error, '[Atoma] dispatch failed')
            event.ticket?.settle('enqueued', err)
            event.onFail?.(err)
        })
    }

    flush() {
        if (this.scheduled) return
        this.scheduled = true
        queueMicrotask(() => {
            this.scheduled = false
            void this.drainLoop()
        })
    }

    flushSync() {
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
                    const segments = this.segmentByContext(events)
                    for (const ops of segments) {
                        await this.runSegment(ops)
                    }
                }
            }
        } finally {
            this.draining = false
        }
    }

    private segmentByContext(events: Array<StoreDispatchEvent<any>>) {
        const segments: Array<Array<StoreDispatchEvent<any>>> = []
        let current: Array<StoreDispatchEvent<any>> = []
        let currentKey: string | undefined

        events.forEach((op) => {
            const key = segmentKey(op)
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

    private async runSegment(ops: Array<StoreDispatchEvent<any>>) {
        const handle = ops[0].handle
        const atom = handle.atom
        const store = handle.jotaiStore

        const observabilityContext = handle.createObservabilityContext
            ? handle.createObservabilityContext()
            : handle.observability.createContext()

        const baseOpContext = ops[0].opContext
        const segmentOpContext = normalizeOperationContext(
            baseOpContext ? ({ ...(baseOpContext as any), traceId: undefined } as any) : undefined,
            { traceId: observabilityContext.traceId }
        )

        const segmentOps = ops.map(op => ({ ...op, opContext: segmentOpContext }))

        const plan = this.deps.executor.planner.plan(segmentOps, store.get(atom))

        const hooks = handle.services.mutation.hooks
        const plannedEvent: PlannedEvent<any> = {
            storeName: handle.storeName,
            opContext: segmentOpContext,
            handle,
            operations: segmentOps as any,
            plan: plan as any,
            observabilityContext
        }
        await hooks.events.planned.emit(plannedEvent as any)

        await this.deps.executor.run({
            handle,
            operations: segmentOps as any,
            plan: plan as any,
            atom,
            store,
            versionTracker: this.deps.versionTracker,
            indexes: handle.indexes,
            observabilityContext,
            storeName: handle.storeName,
            opContext: segmentOpContext
        })
    }
}
