import { throwError } from '../../error'
import { normalizeId } from '../../shared/utils/id'
import type { OkWriteReplay } from './idempotency'
import { appendWriteChange } from './appendWriteChange'
import type { WriteContext, WriteSuccess } from './types'

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export async function applyCreate(ctx: WriteContext): Promise<WriteSuccess> {
    if (typeof ctx.orm.create !== 'function') {
        throwError('ADAPTER_NOT_IMPLEMENTED', 'Adapter does not implement create', { kind: 'adapter' })
    }

    const data = isPlainObject(ctx.write.data) ? { ...ctx.write.data } : {}
    if (ctx.write.id !== undefined) data.id = ctx.write.id
    if (!(typeof data.version === 'number' && Number.isFinite(data.version) && data.version >= 1)) data.version = 1

    const res = await ctx.orm.create(
        ctx.write.resource,
        data,
        { returning: true, ...(ctx.internalSelect ? { select: ctx.internalSelect } : {}) } as any
    )
    if (res?.error) throw res.error

    const row = res?.data
    const expectedId = ctx.write.id !== undefined ? normalizeId(ctx.write.id) : ''
    const actualId = normalizeId((row as any)?.id)

    if (ctx.write.id !== undefined && expectedId && actualId && expectedId !== actualId) {
        throwError('INTERNAL', `Create returned mismatched id (expected=${expectedId}, actual=${actualId})`, {
            kind: 'internal',
            resource: ctx.write.resource
        })
    }
    if (ctx.write.id === undefined && !actualId) {
        throwError('INTERNAL', 'Create returned missing id', {
            kind: 'internal',
            resource: ctx.write.resource
        })
    }

    const id = ctx.write.id !== undefined ? expectedId : actualId
    const serverVersion = typeof (row as any)?.version === 'number' ? (row as any).version : 1
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
