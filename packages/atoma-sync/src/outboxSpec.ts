import { Protocol, type Operation, type WriteAction, type WriteItem } from 'atoma/protocol'
import type { SyncOutboxItem } from './types'

export type OutboxWriteInfo = {
    opId: string
    resource: string
    action: WriteAction
    item: WriteItem
    options?: any
}

export function readOutboxWrite(entry: SyncOutboxItem): OutboxWriteInfo {
    const op: any = (entry as any).op
    if (!op || op.kind !== 'write') throw new Error('[Sync] outbox entry must contain write op')
    const write: any = op.write
    const resource = String(write?.resource ?? '')
    const action = write?.action as WriteAction
    const item = (Array.isArray(write?.items) ? write.items[0] : undefined) as WriteItem | undefined
    if (!resource || !action || !item) throw new Error('[Sync] invalid outbox write op')
    const options = (write?.options && typeof write.options === 'object') ? write.options : undefined
    return { opId: String(op.opId), resource, action, item, ...(options ? { options } : {}) }
}

export function ensureOutboxWriteOp(args: { entry: SyncOutboxItem; returning: boolean }): Operation {
    const write = readOutboxWrite(args.entry)
    const meta = (write.item as any)?.meta
    if (!meta || typeof meta !== 'object' || typeof (meta as any).idempotencyKey !== 'string' || !(meta as any).idempotencyKey) {
        throw new Error('[Sync] outbox write item meta.idempotencyKey is required')
    }
    if ((meta as any).idempotencyKey !== args.entry.idempotencyKey) {
        throw new Error('[Sync] outbox entry idempotencyKey must match write item meta.idempotencyKey')
    }

    const options = write.options && typeof write.options === 'object' ? write.options : undefined
    const ensuredOptions = {
        ...(options ? options : {}),
        returning: args.returning
    }

    return Protocol.ops.build.buildWriteOp({
        opId: write.opId,
        write: {
            resource: write.resource,
            action: write.action,
            items: [write.item],
            options: ensuredOptions
        }
    })
}

export function assertOutboxItemValid(entry: SyncOutboxItem) {
    const write = readOutboxWrite(entry)
    const meta = (write.item as any)?.meta
    if (!meta || typeof meta !== 'object' || typeof (meta as any).idempotencyKey !== 'string' || !(meta as any).idempotencyKey) {
        throw new Error('[Sync] outbox write item meta.idempotencyKey is required')
    }
    if ((meta as any).idempotencyKey !== entry.idempotencyKey) {
        throw new Error('[Sync] outbox entry idempotencyKey must match write item meta.idempotencyKey')
    }
    if (typeof (meta as any).clientTimeMs !== 'number' || !Number.isFinite((meta as any).clientTimeMs)) {
        throw new Error('[Sync] outbox write item meta.clientTimeMs is required')
    }
    const op: any = (entry as any).op
    try {
        Protocol.ops.validate.assertOutgoingOps({
            ops: [op],
            meta: Protocol.ops.build.buildRequestMeta({ now: () => Date.now() })
        })
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        throw new Error(`[Sync] invalid outbox write op: ${msg}`)
    }
}
