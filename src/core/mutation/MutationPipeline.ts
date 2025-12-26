import type { StoreDispatchEvent, StoreOperationOptions, WriteItemMeta, WriteTicket } from '../types'
import { Executor } from './pipeline/Executor'
import type { IExecutor } from './pipeline/types'
import { Scheduler } from './pipeline/Scheduler'
import { TicketTracker } from './pipeline/TicketTracker'
import { VersionManager } from './pipeline/VersionManager'
import { createMutationHooks, type Extensions, type MutationHooks } from './hooks'

export type MutationRuntime = Readonly<{
    dispatch: (event: StoreDispatchEvent<any>) => void
    beginWrite: () => { ticket: WriteTicket; meta: WriteItemMeta }
    await: (ticket: WriteTicket, options?: StoreOperationOptions) => Promise<void>
}>

export type MutationControl = Readonly<{
    onAck: (idempotencyKey: string) => void
    onReject: (idempotencyKey: string, reason?: unknown) => void
    remotePull: (args: { storeName: string; changes: unknown; extensions?: Extensions }) => void
    remoteAck: (args: { storeName: string; idempotencyKey?: string; ack: unknown; extensions?: Extensions }) => void
    remoteReject: (args: { storeName: string; idempotencyKey?: string; reject: unknown; reason?: unknown; extensions?: Extensions }) => void
}>

export class MutationPipeline {
    readonly runtime: MutationRuntime
    readonly control: MutationControl
    readonly versions: VersionManager
    readonly hooks: MutationHooks

    private readonly executor: IExecutor
    private readonly scheduler: Scheduler
    private readonly tickets: TicketTracker

    constructor() {
        this.hooks = createMutationHooks()
        this.versions = new VersionManager()
        this.executor = new Executor()
        this.scheduler = new Scheduler({ executor: this.executor, versionTracker: this.versions })
        this.tickets = new TicketTracker()

        this.runtime = {
            dispatch: (event) => this.scheduler.enqueue(event),
            beginWrite: () => this.tickets.beginWrite(),
            await: (ticket, options) => this.tickets.await(ticket, options)
        }

        this.control = {
            onAck: (idempotencyKey) => this.tickets.onAck(idempotencyKey),
            onReject: (idempotencyKey, reason) => this.tickets.onReject(idempotencyKey, reason)
            ,
            remotePull: (args) => {
                void this.hooks.events.remotePull.emit({
                    storeName: args.storeName,
                    changes: args.changes,
                    extensions: args.extensions
                })
            },
            remoteAck: (args) => {
                if (typeof args.idempotencyKey === 'string' && args.idempotencyKey) {
                    this.tickets.onAck(args.idempotencyKey)
                }
                void this.hooks.events.remoteAck.emit({
                    storeName: args.storeName,
                    idempotencyKey: args.idempotencyKey,
                    ack: args.ack,
                    extensions: args.extensions
                })
            },
            remoteReject: (args) => {
                if (typeof args.idempotencyKey === 'string' && args.idempotencyKey) {
                    this.tickets.onReject(args.idempotencyKey, args.reason)
                }
                void this.hooks.events.remoteReject.emit({
                    storeName: args.storeName,
                    idempotencyKey: args.idempotencyKey,
                    reject: args.reject,
                    reason: args.reason,
                    extensions: args.extensions
                })
            }
        }
    }
}
