import { throwError } from '../../error'
import { applyCreate } from './writeCreate'
import { applyDelete } from './writeDelete'
import { applyUpdate } from './writeUpdate'
import { applyUpsert } from './writeUpsert'
import type { WriteContext, WriteSuccess } from './types'

export async function applyWriteByKind(ctx: WriteContext): Promise<WriteSuccess> {
    if (ctx.write.kind === 'create') return applyCreate(ctx)
    if (ctx.write.kind === 'upsert') return applyUpsert(ctx)
    if (ctx.write.kind === 'update') return applyUpdate(ctx)
    if (ctx.write.kind === 'delete') return applyDelete(ctx)
    throwError('INVALID_WRITE', 'Unsupported write kind', { kind: 'validation', resource: ctx.write.resource })
}
