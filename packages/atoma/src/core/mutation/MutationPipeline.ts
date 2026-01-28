/**
 * Mutation Pipeline: Entry
 * Purpose: Wires scheduling and ticket tracking for store mutations.
 * Call chain: Store.dispatch -> MutationPipeline.api.dispatch -> Scheduler.enqueue -> executeMutationFlow -> emitCommit.
 */
import type { CoreRuntime, StoreDispatchEvent, StoreOperationOptions, WriteItemMeta, WriteTicket } from '../types'
import { Scheduler } from './pipeline/Scheduler'
import { WriteTicketManager } from './pipeline/WriteTicketManager'
import type { StoreCommit } from './pipeline/types'
import { executeMutationFlow } from './pipeline/MutationFlow'

export type MutationApi = Readonly<{
    dispatch: (event: StoreDispatchEvent<any>) => void
    beginWrite: () => { ticket: WriteTicket; meta: WriteItemMeta }
    awaitTicket: (ticket: WriteTicket, options?: StoreOperationOptions) => Promise<void>
}>

export type MutationAcks = Readonly<{
    ack: (idempotencyKey: string) => void
    reject: (idempotencyKey: string, reason?: unknown) => void
}>

export class MutationPipeline {
    readonly api: MutationApi
    readonly acks: MutationAcks

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

        this.api = {
            dispatch: (event) => this.scheduler.enqueue(event),
            beginWrite: () => this.tickets.beginWrite(),
            awaitTicket: (ticket, options) => this.tickets.awaitTicket(ticket, options)
        }

        this.acks = {
            ack: (idempotencyKey) => this.tickets.ack(idempotencyKey),
            reject: (idempotencyKey, reason) => this.tickets.reject(idempotencyKey, reason)
        }
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
