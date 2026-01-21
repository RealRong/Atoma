import type { CursorStore, SyncApplier, SyncEvent, SyncPhase, SyncTransport } from '../types'
import { Protocol, type ChangeBatch, type Cursor, type Meta, type Operation } from 'atoma/protocol'
import { executeSingleOp, readCursorOrInitial, toError, toOperationError } from '../internal'

export class PullLane {
    private disposed = false
    private pulling = false

    private pullPending = false
    private pullInFlight?: Promise<ChangeBatch | undefined>
    private pullWaiters: Array<{ resolve: (batch: ChangeBatch | undefined) => void; reject: (error: unknown) => void }> = []
    private pullTimer?: ReturnType<typeof setTimeout>

    constructor(private readonly deps: {
        cursor: CursorStore
        transport: SyncTransport
        applier: SyncApplier
        pullLimit: number
        debounceMs: number
        resources?: string[]
        initialCursor?: Cursor
        buildMeta: () => Meta
        nextOpId: (prefix: 'c') => string
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: SyncEvent) => void
    }) {}

    stop(reason: string) {
        this.clearPullTimer()
        this.rejectPullWaiters(new Error(reason))
        this.pullPending = false
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.stop('[Sync] pull disposed')
    }

    requestPull(args: { cause: 'manual' | 'periodic' | 'notify'; resources?: string[]; debounceMs?: number }): Promise<ChangeBatch | undefined> {
        if (this.disposed) return Promise.resolve(undefined)

        if (args.cause === 'notify' && !this.shouldPullForResources(args.resources)) {
            return Promise.resolve(undefined)
        }

        this.pullPending = true
        this.deps.onEvent?.({ type: 'pull:scheduled', cause: args.cause })

        const delay = Math.max(0, Math.floor(typeof args.debounceMs === 'number' ? args.debounceMs : this.deps.debounceMs))

        const promise = new Promise<ChangeBatch | undefined>((resolve, reject) => {
            this.pullWaiters.push({ resolve, reject })
        })

        if (delay > 0 && !this.pulling) {
            if (!this.pullTimer) {
                this.pullTimer = setTimeout(() => {
                    this.pullTimer = undefined
                    void this.drainPull().catch(() => {
                        // waiters are rejected inside drainPull
                    })
                }, delay)
            }
            return promise
        }

        this.clearPullTimer()
        void this.drainPull().catch(() => {
            // waiters are rejected inside drainPull
        })
        return promise
    }

    private shouldPullForResources(resources: unknown): boolean {
        const allow = this.deps.resources
        if (!allow?.length) return true
        if (!Array.isArray(resources) || !resources.length) return true
        const allowSet = new Set(allow)
        for (const r of resources) {
            if (typeof r === 'string' && allowSet.has(r)) return true
        }
        return false
    }

    private clearPullTimer() {
        if (!this.pullTimer) return
        clearTimeout(this.pullTimer)
        this.pullTimer = undefined
    }

    private rejectPullWaiters(error: Error) {
        const waiters = this.pullWaiters
        this.pullWaiters = []
        waiters.forEach(w => w.reject(error))
    }

    private async drainPull(): Promise<ChangeBatch | undefined> {
        this.clearPullTimer()
        if (this.pullInFlight) return this.pullInFlight

        const run = async (): Promise<ChangeBatch | undefined> => {
            this.pulling = true
            this.deps.onEvent?.({ type: 'pull:start' })
            let lastBatch: ChangeBatch | undefined
            try {
                while (this.pullPending && !this.disposed) {
                    this.pullPending = false
                    const batch = await this.pullOnce()
                    if (batch) lastBatch = batch
                }
                const waiters = this.pullWaiters
                this.pullWaiters = []
                waiters.forEach(w => w.resolve(lastBatch))
                return lastBatch
            } catch (error) {
                const waiters = this.pullWaiters
                this.pullWaiters = []
                waiters.forEach(w => w.reject(error))
                throw error
            } finally {
                this.pulling = false
                this.pullInFlight = undefined
                this.deps.onEvent?.({ type: 'pull:idle' })
            }
        }

        this.pullInFlight = run()
        return this.pullInFlight
    }

    private async pullOnce(): Promise<ChangeBatch | undefined> {
        if (this.disposed) throw new Error('PullLane disposed')

        try {
            const cursor = await readCursorOrInitial({
                cursor: this.deps.cursor,
                initialCursor: this.deps.initialCursor
            })
            const limit = Math.max(1, Math.floor(this.deps.pullLimit))
            const meta = this.deps.buildMeta()
            const opId = this.deps.nextOpId('c')
            const resources = this.deps.resources

            const op: Operation = Protocol.ops.build.buildChangesPullOp({
                opId,
                cursor,
                limit,
                ...(resources?.length ? { resources } : {})
            })

            const opResult = await executeSingleOp({
                transport: this.deps.transport,
                op,
                meta
            })

            if (!opResult.ok) {
                throw toOperationError(opResult)
            }

            const batch = opResult.data as ChangeBatch
            if (batch.changes.length) {
                await Promise.resolve(this.deps.applier.applyPullChanges(batch.changes))
            }
            await this.deps.cursor.set(batch.nextCursor)
            return batch
        } catch (error) {
            this.deps.onError?.(toError(error), { phase: 'pull' })
            throw error
        }
    }
}
