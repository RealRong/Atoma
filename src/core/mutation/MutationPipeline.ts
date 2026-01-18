/**
 * Mutation Pipeline: Entry
 * Purpose: Wires scheduling, ticket tracking, and history recording for store mutations.
 * Call chain: Store.dispatch -> MutationPipeline.api.dispatch -> Scheduler.enqueue -> executeMutationFlow -> HistoryManager.record.
 */
import type { StoreDispatchEvent, StoreOperationOptions, WriteItemMeta, WriteTicket } from '../types'
import { executeMutationFlow } from './pipeline/MutationFlow'
import { Scheduler } from './pipeline/Scheduler'
import { WriteTicketManager } from './pipeline/WriteTicketManager'
import { HistoryManager } from '../history/HistoryManager'

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
    readonly history: HistoryManager

    private readonly scheduler: Scheduler
    private readonly tickets: WriteTicketManager

    constructor() {
        this.history = new HistoryManager()
        this.scheduler = new Scheduler({
            run: async (args) => {
                const committed = await executeMutationFlow(args)
                if (committed) this.history.record(committed)
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
}
