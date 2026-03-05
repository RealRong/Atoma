import { throwError } from '../../error'
import { normalizeId } from '../../shared/utils/id'
import type { OkWriteReplay } from './idempotency'
import { appendWriteChange } from './appendWriteChange'
import type { WriteContext, WriteSuccess } from './types'

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export async function applyUpdate(ctx: WriteContext): Promise<WriteSuccess> {
    if (typeof ctx.orm.update !== 'function') {
        throwError('ADAPTER_NOT_IMPLEMENTED', 'Adapter does not implement update', { kind: 'adapter' })
    }
    if (ctx.write.id === undefined) {
        throwError('INVALID_WRITE', 'Missing id for update', { kind: 'validation', resource: ctx.write.resource })
    }
    if (typeof ctx.write.baseVersion !== 'number' || !Number.isFinite(ctx.write.baseVersion) || ctx.write.baseVersion <= 0) {
        throwError('INVALID_WRITE', 'Missing baseVersion for update', { kind: 'validation', resource: ctx.write.resource })
    }

    const id = normalizeId(ctx.write.id)
    const data = isPlainObject(ctx.write.data) ? { ...ctx.write.data } : {}
    const res = await ctx.orm.update(
        ctx.write.resource,
        { id: ctx.write.id, data, baseVersion: ctx.write.baseVersion } as any,
        { ...ctx.options, returning: true, ...(ctx.internalSelect ? { select: ctx.internalSelect } : {}) } as any
    )
    if (res?.error) throw res.error

    const row = res?.data
    const serverVersion = typeof (row as any)?.version === 'number'
        ? (row as any).version
        : ctx.write.baseVersion + 1
    const change = await appendWriteChange({ ctx, id, kind: 'upsert', serverVersion })
    const replay: OkWriteReplay = {
        kind: 'ok',
        resource: ctx.write.resource,
        id,
        changeKind: 'upsert',
        serverVersion,
        ...(change ? { cursor: change.cursor } : {}),
        data: row
    }

    return { replay, data: row, ...(change ? { change } : {}) }
}
