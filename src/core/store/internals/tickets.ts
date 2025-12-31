import type { WriteTicket } from '../../types'

export function ignoreTicketRejections(ticket: WriteTicket) {
    void ticket.enqueued.catch(() => {
        // avoid unhandled rejection when optimistic writes never await enqueued
    })
    void ticket.confirmed.catch(() => {
        // avoid unhandled rejection when optimistic writes never await confirmed
    })
}

