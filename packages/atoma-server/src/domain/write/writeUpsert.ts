import { throwError } from '../../error'
import { normalizeId } from '../../shared/utils/id'
import type { OkWriteReplay } from './idempotency'
import { appendWriteChange } from './appendWriteChange'
import type { WriteContext, WriteSuccess } from './types'

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export async function applyUpsert(ctx: WriteContext): Promise<WriteSuccess> {
    if (typeof ctx.orm.upsert !== 'function') {
        throwError('ADAPTER_NOT_IMPLEMENTED', 'Adapter does not implement upsert', { kind: 'adapter' })
    }
    if (ctx.write.id === undefined) {
        throwError('INVALID_WRITE', 'Missing id for upsert', { kind: 'validation', resource: ctx.write.resource })
    }

    const id = normalizeId(ctx.write.id)
    const data = isPlainObject(ctx.write.data) ? { ...ctx.write.data } : {}
    const conflict: 'cas' | 'lww' = (ctx.options as any)?.upsert?.conflict === 'lww' ? 'lww' : 'cas'
    const apply: 'merge' | 'replace' = (ctx.options as any)?.upsert?.apply === 'replace' ? 'replace' : 'merge'
    const res = await ctx.orm.upsert(
        ctx.write.resource,
        { id, data, expectedVersion: ctx.write.expectedVersion, conflict, apply } as any,
        { ...ctx.options, returning: true, ...(ctx.internalSelect ? { select: ctx.internalSelect } : {}) } as any
    )
    if (res?.error) throw res.error

    const row = res?.data
    const serverVersion = (row as any)?.version
    if (!(typeof serverVersion === 'number' && Number.isFinite(serverVersion) && serverVersion >= 1)) {
        throwError('INTERNAL', 'Upsert returned missing version', { kind: 'internal', resource: ctx.write.resource })
    }

    const change = await appendWriteChange({ ctx, id, kind: 'upsert', serverVersion })
    const replay: OkWriteReplay = {
        kind: 'ok',
        resource: ctx.write.resource,
        id,
        changeKind: 'upsert',
        serverVersion,
        ...(change ? { cursor: change.cursor } : {}),
        ...(ctx.returningRequested ? { data: row } : {})
    }

    return { replay, ...(ctx.returningRequested ? { data: row } : {}), ...(change ? { change } : {}) }
}
