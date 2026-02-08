import type { WriteIntent, WriteIntentOptions } from 'atoma-types/core'
import type { EntityId, WriteAction, WriteItem, WriteItemMeta, WriteOp, WriteOptions } from 'atoma-types/protocol'
import { buildWriteOp, createIdempotencyKey, ensureWriteItemMeta } from 'atoma-types/protocol-tools'

export function buildWriteOperation(args: {
    opId: string
    resource: string
    action: WriteAction
    items: WriteItem[]
    options?: WriteOptions
}): WriteOp {
    return buildWriteOp({
        opId: args.opId,
        write: {
            resource: args.resource,
            action: args.action,
            items: args.items,
            ...(args.options ? { options: args.options } : {})
        }
    })
}

export function buildWriteItemMeta(args: { now: () => number }): WriteItemMeta {
    const meta: WriteItemMeta = {
        idempotencyKey: createIdempotencyKey({ now: args.now }),
        clientTimeMs: args.now()
    }

    return ensureWriteItemMeta({
        meta,
        now: args.now
    })
}

export function buildWriteItem(intent: WriteIntent, meta: WriteItemMeta): WriteItem {
    if (intent.action === 'delete') {
        return {
            entityId: intent.entityId as EntityId,
            baseVersion: intent.baseVersion as number,
            meta
        }
    }
    if (intent.action === 'update') {
        return {
            entityId: intent.entityId as EntityId,
            baseVersion: intent.baseVersion as number,
            value: intent.value,
            meta
        }
    }
    if (intent.action === 'upsert') {
        return {
            entityId: intent.entityId as EntityId,
            ...(typeof intent.baseVersion === 'number' ? { baseVersion: intent.baseVersion } : {}),
            value: intent.value,
            meta
        }
    }
    return {
        ...(intent.entityId ? { entityId: intent.entityId } : {}),
        value: intent.value,
        meta
    }
}

export function buildWriteOptions(options?: WriteIntentOptions): WriteOptions | undefined {
    if (!options) return undefined
    const out: WriteOptions = {}
    if (typeof options.merge === 'boolean') out.merge = options.merge
    if (options.upsert?.mode === 'strict' || options.upsert?.mode === 'loose') {
        out.upsert = { mode: options.upsert.mode }
    }
    return Object.keys(out).length ? out : undefined
}
