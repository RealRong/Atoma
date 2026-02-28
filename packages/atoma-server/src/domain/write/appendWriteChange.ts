import { appendChangeIfEnabled } from './changeLog'
import type { WriteContext } from './types'

export async function appendWriteChange(args: {
    ctx: WriteContext
    id: string
    kind: 'upsert' | 'delete'
    serverVersion: number
}) {
    return appendChangeIfEnabled({
        syncEnabled: args.ctx.syncEnabled,
        sync: args.ctx.sync,
        tx: args.ctx.tx,
        entry: {
            resource: args.ctx.write.resource,
            id: args.id,
            kind: args.kind,
            serverVersion: args.serverVersion,
            changedAt: args.ctx.changedAt
        }
    })
}
