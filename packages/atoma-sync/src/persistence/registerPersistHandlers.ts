import type { ClientPluginContext } from 'atoma/client'
import type { Entity, PersistRequest, PersistResult } from 'atoma/core'
import type { OutboxStore } from '#sync/types'
import { mapTranslatedWriteOpsToOutboxWrites } from './mapTranslatedWriteOpsToOutboxWrites'

export function registerSyncPersistHandlers(args: {
    ctx: ClientPluginContext
    outbox: OutboxStore
}): Array<() => void> {
    const unregister: Array<() => void> = []

    unregister.push(args.ctx.persistence.register('queue', async <T extends Entity>(x: {
        req: PersistRequest<T>
        next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
    }) => {
        const writes = mapTranslatedWriteOpsToOutboxWrites(x.req.writeOps)
        if (writes.length) await args.outbox.enqueueWrites({ writes })
        return { status: 'enqueued' } as PersistResult<T>
    }))

    unregister.push(args.ctx.persistence.register('local-first', async <T extends Entity>(x: {
        req: PersistRequest<T>
        next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
    }) => {
        const direct = await x.next(x.req)
        const writes = mapTranslatedWriteOpsToOutboxWrites(x.req.writeOps)
        if (writes.length) await args.outbox.enqueueWrites({ writes })
        return {
            status: 'enqueued',
            ...(direct.created ? { created: direct.created } : {}),
            ...(direct.writeback ? { writeback: direct.writeback } : {})
        } as PersistResult<T>
    }))

    return unregister
}
