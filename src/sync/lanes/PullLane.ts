import type { CursorStore, SyncEvent, SyncPhase, SyncTransport } from '../types'
import type { ChangeBatch, Cursor, Meta, Operation } from '#protocol'
import type { SyncApplier } from '../internal'
import { executeSingleOp, readCursorOrInitial, toError, toOperationError } from '../internal'

export class PullLane {
    private disposed = false
    private pulling = false

    constructor(private readonly deps: {
        cursor: CursorStore
        transport: SyncTransport
        applier: SyncApplier
        pullLimit: number
        resources?: string[]
        initialCursor?: Cursor
        buildMeta: () => Meta
        nextOpId: (prefix: 'c') => string
        onError?: (error: Error, context: { phase: SyncPhase }) => void
        onEvent?: (event: SyncEvent) => void
    }) {}

    dispose() {
        this.disposed = true
    }

    async pull(): Promise<ChangeBatch | undefined> {
        if (this.disposed) throw new Error('PullLane disposed')
        if (this.pulling) return undefined
        this.pulling = true
        this.deps.onEvent?.({ type: 'pull:start' })
        try {
            const cursor = await readCursorOrInitial({
                cursor: this.deps.cursor,
                initialCursor: this.deps.initialCursor
            })
            const limit = Math.max(1, Math.floor(this.deps.pullLimit))
            const meta = this.deps.buildMeta()
            const opId = this.deps.nextOpId('c')
            const resources = this.deps.resources

            const op: Operation = {
                opId,
                kind: 'changes.pull',
                pull: {
                    cursor,
                    limit,
                    ...(resources?.length ? { resources } : {})
                }
            }

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
                await Promise.resolve(this.deps.applier.applyChanges(batch.changes))
            }
            await this.deps.cursor.set(batch.nextCursor)
            return batch
        } catch (error) {
            this.deps.onError?.(toError(error), { phase: 'pull' })
            throw error
        } finally {
            this.pulling = false
            this.deps.onEvent?.({ type: 'pull:idle' })
        }
    }
}
