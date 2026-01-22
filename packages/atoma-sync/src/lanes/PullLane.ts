import type { CursorStore, SyncApplier, SyncEvent, SyncPhase, SyncTransport } from '#sync/types'
import type { ChangeBatch, Cursor, Meta } from 'atoma/protocol'
import { readCursorOrInitial, toError } from '#sync/internal'
import { createSingleflight } from '#sync/internal/singleflight'
import PQueue from 'p-queue'
import debounce from 'p-debounce'

export class PullLane {
    private disposed = false
    private pullPending = false
    private drainQueued = false
    private readonly queue = new PQueue({ concurrency: 1 })
    private readonly singleflight = createSingleflight<ChangeBatch | undefined>()
    private debounceController?: AbortController
    private debouncedDrain?: () => Promise<void>

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
    }) {
        this.resetDebouncer()
    }

    stop(reason: string) {
        this.resetDebouncer()
        this.singleflight.cancel(new Error(reason))
        this.pullPending = false
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

        // Only notify is debounced; periodic/manual are already explicitly scheduled.
        if (args.cause !== 'notify') {
            this.enqueueDrain()
            return flight.promise
        }

        if (this.debouncedDrain) {
            void this.debouncedDrain().catch(() => {
                // errors are routed via drain + onError
            })
        } else {
            this.enqueueDrain()
        }
        return flight.promise
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

    private resetDebouncer() {
        try {
            this.debounceController?.abort()
        } catch {
            // ignore
        }

        const delay = Math.max(0, Math.floor(this.deps.debounceMs))
        if (delay <= 0) {
            this.debounceController = undefined
            this.debouncedDrain = undefined
            return
        }

        this.debounceController = new AbortController()
        this.debouncedDrain = debounce(async () => {
            this.enqueueDrain()
        }, delay, { signal: this.debounceController.signal })
    }

    private enqueueDrain() {
        if (this.disposed) return
        if (this.drainQueued) return
        this.drainQueued = true

        void this.queue.add(async () => {
            if (this.disposed) return
            if (!this.pullPending) return

            const flight = this.singleflight.peek()
            const flightId = flight?.id
            this.deps.onEvent?.({ type: 'pull:start' })
            let lastBatch: ChangeBatch | undefined

            try {
                while (this.pullPending && !this.disposed) {
                    this.pullPending = false
                    const batch = await this.pullOnce()
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
        }).finally(() => {
            this.drainQueued = false
            if (this.pullPending && !this.disposed) {
                this.enqueueDrain()
            }
        })
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
            const resources = this.deps.resources

            const batch = await this.deps.transport.pullChanges({
                cursor,
                limit,
                ...(resources?.length ? { resources } : {}),
                meta
            })
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
