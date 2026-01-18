/**
 * Mutation Pipeline: Write Ticket Manager
 * Purpose: Creates write tickets and resolves optimistic/strict confirmations with ack/reject.
 * Call chain: MutationPipeline.api.beginWrite/awaitTicket -> WriteTicketManager.awaitTicket -> MutationPipeline.acks.ack/reject.
 */
import { toErrorWithFallback } from '#shared'
import type { StoreOperationOptions, WriteItemMeta, WriteTicket, WriteTimeoutBehavior, WriteConfirmation } from '../../types'
import { Protocol } from '#protocol'

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (reason?: unknown) => void
    settled: boolean
}

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const deferred: Deferred<T> = {
        promise: new Promise<T>((res, rej) => {
            resolve = res
            reject = rej
        }),
        resolve: (value) => {
            if (deferred.settled) return
            deferred.settled = true
            resolve(value)
        },
        reject: (reason) => {
            if (deferred.settled) return
            deferred.settled = true
            reject(reason)
        },
        settled: false
    }
    return deferred
}

export class WriteTimeoutError extends Error {
    name = 'WriteTimeoutError'

    constructor(args: { idempotencyKey: string; timeoutMs: number }) {
        super(`Write timed out after ${args.timeoutMs}ms (idempotencyKey=${args.idempotencyKey})`)
    }
}

export class WriteTicketManager {
    private readonly pending = new Map<string, WriteTicket>()

    constructor(private readonly now: () => number = () => Date.now()) { }

    beginWrite(): { ticket: WriteTicket; meta: WriteItemMeta } {
        const meta: WriteItemMeta = {
            idempotencyKey: Protocol.ids.createIdempotencyKey({ now: this.now }),
            clientTimeMs: this.now()
        }

        const enqueued = createDeferred<void>()
        const confirmed = createDeferred<void>()

        const ticket: WriteTicket = {
            idempotencyKey: meta.idempotencyKey,
            clientTimeMs: meta.clientTimeMs,
            enqueued: enqueued.promise,
            confirmed: confirmed.promise,
            settle: (stage, error) => {
                if (stage === 'enqueued') {
                    if (error !== undefined) {
                        const err = toErrorWithFallback(error, 'Write enqueued failed')
                        enqueued.reject(err)
                        confirmed.reject(err)
                        return
                    }
                    enqueued.resolve(undefined)
                    return
                }

                if (!enqueued.settled) {
                    enqueued.resolve(undefined)
                }

                if (error !== undefined) {
                    confirmed.reject(toErrorWithFallback(error, 'Write confirmed failed'))
                    return
                }

                confirmed.resolve(undefined)
            }
        }

        return { ticket, meta }
    }

    async awaitTicket(ticket: WriteTicket, options?: StoreOperationOptions): Promise<void> {
        const confirmation: WriteConfirmation = options?.confirmation ?? 'optimistic'

        if (confirmation === 'optimistic') {
            void ticket.confirmed.catch(() => {
                // avoid unhandled rejection when optimistic writes never await confirmed
            })
            await ticket.enqueued
            return
        }

        void ticket.enqueued.catch(() => {
            // avoid unhandled rejection when strict writes never await enqueued
        })

        this.pending.set(ticket.idempotencyKey, ticket)

        try {
            const timeoutMs = options?.timeoutMs
            if (!(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0)) {
                await ticket.confirmed
                return
            }

            const timeoutBehavior: WriteTimeoutBehavior = options?.timeoutBehavior ?? 'reject'

            await Promise.race([
                ticket.confirmed,
                new Promise<void>((_resolve, reject) => {
                    setTimeout(() => reject(new WriteTimeoutError({ idempotencyKey: ticket.idempotencyKey, timeoutMs })), timeoutMs)
                })
            ]).catch(async (err) => {
                if (err instanceof WriteTimeoutError) {
                    if (timeoutBehavior === 'resolve-enqueued') {
                        await ticket.enqueued
                        return
                    }
                }
                throw err
            })
        } finally {
            if (this.pending.get(ticket.idempotencyKey) === ticket) {
                this.pending.delete(ticket.idempotencyKey)
            }
        }
    }

    ack(idempotencyKey: string) {
        const ticket = this.pending.get(idempotencyKey)
        if (!ticket) return
        ticket.settle('confirmed')
        this.pending.delete(idempotencyKey)
    }

    reject(idempotencyKey: string, reason?: unknown) {
        const ticket = this.pending.get(idempotencyKey)
        if (!ticket) return
        ticket.settle('confirmed', reason)
        this.pending.delete(idempotencyKey)
    }
}
