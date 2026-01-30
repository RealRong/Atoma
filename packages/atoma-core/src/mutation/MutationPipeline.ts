/**
 * Mutation Pipeline: Entry
 * Purpose: Wires scheduling and ticket tracking for store mutations.
 * Call chain: Store.dispatch -> MutationPipeline.dispatch -> Scheduler.enqueue -> executeMutationFlow -> emitCommit.
 */
import type { CoreRuntime, StoreDispatchEvent, StoreOperationOptions, WriteItemMeta, WriteTicket } from '../types'
import { Scheduler } from './pipeline/Scheduler'
import { WriteTicketManager } from './pipeline/WriteTicketManager'
import type { StoreCommit } from './pipeline/types'
import { executeMutationFlow } from './pipeline/MutationFlow'

export class MutationPipeline {
    private readonly scheduler: Scheduler
    private readonly tickets: WriteTicketManager
    private readonly commitListeners = new Set<(commit: StoreCommit) => void>()

    constructor(runtime: CoreRuntime) {
        this.scheduler = new Scheduler({
            run: async (segment) => {
                const committed = await executeMutationFlow(runtime, segment)
                if (committed) this.emitCommit(committed)
            }
        })
        this.tickets = new WriteTicketManager()
    }

    dispatch = (event: StoreDispatchEvent<any>) => {
        this.scheduler.enqueue(event)
    }

    begin = (): { ticket: WriteTicket; meta: WriteItemMeta } => {
        return this.tickets.beginWrite()
    }

    await = (ticket: WriteTicket, options?: StoreOperationOptions) => {
        return this.tickets.awaitTicket(ticket, options)
    }

    ack = (idempotencyKey: string) => {
        this.tickets.ack(idempotencyKey)
    }

    reject = (idempotencyKey: string, reason?: unknown) => {
        this.tickets.reject(idempotencyKey, reason)
    }

    subscribeCommit = (listener: (commit: StoreCommit) => void) => {
        this.commitListeners.add(listener)
        return () => {
            this.commitListeners.delete(listener)
        }
    }

    private emitCommit = (commit: StoreCommit) => {
        if (!this.commitListeners.size) return
        for (const listener of this.commitListeners) {
            try {
                listener(commit)
            } catch {
                // ignore
            }
        }
    }
}
