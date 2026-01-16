import type { StoreDispatchEvent, StoreOperationOptions, WriteItemMeta, WriteTicket } from '../types'
import { runMutationFlow } from './pipeline/Flow'
import { Scheduler } from './pipeline/Scheduler'
import { TicketTracker } from './pipeline/TicketTracker'
import { HistoryManager } from '../history/HistoryManager'

export type MutationRuntime = Readonly<{
    dispatch: (event: StoreDispatchEvent<any>) => void
    beginWrite: () => { ticket: WriteTicket; meta: WriteItemMeta }
    await: (ticket: WriteTicket, options?: StoreOperationOptions) => Promise<void>
}>

export type MutationControl = Readonly<{
    onAck: (idempotencyKey: string) => void
    onReject: (idempotencyKey: string, reason?: unknown) => void
}>

export class MutationPipeline {
    readonly runtime: MutationRuntime
    readonly control: MutationControl
    readonly history: HistoryManager

    private readonly scheduler: Scheduler
    private readonly tickets: TicketTracker

    constructor() {
        this.history = new HistoryManager()
        this.scheduler = new Scheduler({
            run: async (args) => {
                const committed = await runMutationFlow(args)
                if (committed) this.history.record(committed)
            }
        })
        this.tickets = new TicketTracker()

        this.runtime = {
            dispatch: (event) => this.scheduler.enqueue(event),
            beginWrite: () => this.tickets.beginWrite(),
            await: (ticket, options) => this.tickets.await(ticket, options)
        }

        this.control = {
            onAck: (idempotencyKey) => this.tickets.onAck(idempotencyKey),
            onReject: (idempotencyKey, reason) => this.tickets.onReject(idempotencyKey, reason)
        }
    }
}
