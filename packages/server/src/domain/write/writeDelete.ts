import { throwError } from '../../error'
import { normalizeId } from '../../shared/utils/id'
import type { OkWriteReplay } from './idempotency'
import { appendWriteChange } from './appendWriteChange'
import type { WriteContext, WriteSuccess } from './types'

export async function applyDelete(ctx: WriteContext): Promise<WriteSuccess> {
    if (typeof ctx.orm.delete !== 'function') {
        throwError('ADAPTER_NOT_IMPLEMENTED', 'Adapter does not implement delete', { kind: 'adapter' })
    }
    if (ctx.write.id === undefined) {
        throwError('INVALID_WRITE', 'Missing id for delete', { kind: 'validation', resource: ctx.write.resource })
    }
    if (typeof ctx.write.baseVersion !== 'number' || !Number.isFinite(ctx.write.baseVersion)) {
        throwError('INVALID_WRITE', 'Missing baseVersion for delete', { kind: 'validation', resource: ctx.write.resource })
    }

    const res = await ctx.orm.delete(
        ctx.write.resource,
        { id: ctx.write.id, baseVersion: ctx.write.baseVersion } as any,
        { returning: false } as any
    )
    if (res?.error) throw res.error

    const id = normalizeId(ctx.write.id)
    const serverVersion = ctx.write.baseVersion + 1
    const change = await appendWriteChange({ ctx, id, kind: 'delete', serverVersion })
    const replay: OkWriteReplay = {
        kind: 'ok',
        resource: ctx.write.resource,
        id,
        changeKind: 'delete',
        serverVersion,
        ...(change ? { cursor: change.cursor } : {})
    }

    return { replay, ...(change ? { change } : {}) }
}
