import type { WriteAction, WriteItem } from '../types'
import { assertFiniteNumber, assertNonEmptyString, assertPositiveVersion, invalid, isObject, makeValidationDetails } from './common'

type WriteItemCtx = {
    opId: string
    resource: string
    action: WriteAction
    index: number
}

function detailsForWrite(ctx: WriteItemCtx, field?: string) {
    return makeValidationDetails('write', {
        opId: ctx.opId,
        resource: ctx.resource,
        index: ctx.index,
        action: ctx.action
    })(field)
}

function assertWriteItemMeta(value: unknown, ctx: WriteItemCtx) {
    if (!isObject(value)) {
        throw invalid('INVALID_WRITE', 'Missing write item meta', detailsForWrite(ctx, 'meta'))
    }
    const idempotencyKey = (value as any).idempotencyKey
    const clientTimeMs = (value as any).clientTimeMs
    assertNonEmptyString(idempotencyKey, {
        code: 'INVALID_WRITE',
        message: 'Missing meta.idempotencyKey',
        details: detailsForWrite(ctx, 'meta.idempotencyKey')
    })
    assertFiniteNumber(clientTimeMs, {
        code: 'INVALID_WRITE',
        message: 'Missing meta.clientTimeMs',
        details: detailsForWrite(ctx, 'meta.clientTimeMs')
    })
}

function assertWriteItemValue(value: unknown, ctx: WriteItemCtx): Record<string, unknown> {
    if (!isObject(value)) {
        throw invalid('INVALID_WRITE', 'Invalid write item value (must be an object)', detailsForWrite(ctx, 'value'))
    }
    return value
}

function assertEntityIdString(value: unknown, ctx: WriteItemCtx): string {
    return assertNonEmptyString(value, {
        code: 'INVALID_WRITE',
        message: 'Missing entityId',
        details: detailsForWrite(ctx, 'entityId')
    })
}

function assertValueIdMatchesEntityId(args: { entityId?: string; value: Record<string, unknown> } & WriteItemCtx) {
    if (!Object.prototype.hasOwnProperty.call(args.value, 'id')) return
    const id = (args.value as any).id
    if (typeof id !== 'string' || !id) {
        throw invalid('INVALID_WRITE', 'Invalid value.id (must be a non-empty string)', detailsForWrite(args, 'value.id'))
    }
    if (args.entityId && id !== args.entityId) {
        throw invalid('INVALID_WRITE', 'value.id must match entityId', detailsForWrite(args, 'value.id'))
    }
}

function assertCreateItem(raw: Record<string, unknown>, ctx: WriteItemCtx) {
    const entityId = (raw as any).entityId
    if (entityId !== undefined && entityId !== null) {
        assertEntityIdString(entityId, ctx)
    }

    const val = assertWriteItemValue((raw as any).value, ctx)

    // Server-assigned create must not include value.id, otherwise the server can't reliably allocate.
    if (entityId === undefined || entityId === null) {
        if (Object.prototype.hasOwnProperty.call(val, 'id') && (val as any).id !== undefined && (val as any).id !== null) {
            throw invalid('INVALID_WRITE', 'server-assigned create must not include value.id', detailsForWrite(ctx, 'value.id'))
        }
    }

    assertValueIdMatchesEntityId({ entityId: typeof entityId === 'string' ? entityId : undefined, value: val, ...ctx })
}

function assertUpdateItem(raw: Record<string, unknown>, ctx: WriteItemCtx) {
    const entityId = assertEntityIdString((raw as any).entityId, ctx)
    assertPositiveVersion((raw as any).baseVersion, {
        code: 'INVALID_WRITE',
        message: 'Missing baseVersion',
        details: detailsForWrite(ctx, 'baseVersion')
    })
    const val = assertWriteItemValue((raw as any).value, ctx)
    assertValueIdMatchesEntityId({ entityId, value: val, ...ctx })
}

function assertDeleteItem(raw: Record<string, unknown>, ctx: WriteItemCtx) {
    assertEntityIdString((raw as any).entityId, ctx)
    assertPositiveVersion((raw as any).baseVersion, {
        code: 'INVALID_WRITE',
        message: 'Missing baseVersion',
        details: detailsForWrite(ctx, 'baseVersion')
    })
}

function assertUpsertItem(raw: Record<string, unknown>, ctx: WriteItemCtx) {
    const entityId = assertEntityIdString((raw as any).entityId, ctx)
    const baseVersion = (raw as any).baseVersion
    if (baseVersion !== undefined && baseVersion !== null) {
        assertPositiveVersion(baseVersion, {
            code: 'INVALID_WRITE',
            message: 'Invalid baseVersion',
            details: detailsForWrite(ctx, 'baseVersion')
        })
    }
    const val = assertWriteItemValue((raw as any).value, ctx)
    assertValueIdMatchesEntityId({ entityId, value: val, ...ctx })
}

export function assertWriteItems(action: WriteAction, value: unknown, ctx: { opId: string; resource: string }): WriteItem[] {
    if (!Array.isArray(value)) throw invalid('INVALID_REQUEST', 'Missing write.items', { kind: 'validation', part: 'write', opId: ctx.opId, resource: ctx.resource })
    const out: WriteItem[] = []
    for (let index = 0; index < value.length; index++) {
        const raw = value[index]
        if (!isObject(raw)) {
            throw invalid('INVALID_WRITE', 'Invalid write item', { kind: 'validation', part: 'write', opId: ctx.opId, resource: ctx.resource, index, action })
        }

        const itemCtx: WriteItemCtx = { opId: ctx.opId, resource: ctx.resource, action, index }
        const meta = (raw as any).meta
        assertWriteItemMeta(meta, itemCtx)

        switch (action) {
            case 'create':
                assertCreateItem(raw, itemCtx)
                out.push(raw as unknown as WriteItem)
                continue
            case 'update':
                assertUpdateItem(raw, itemCtx)
                out.push(raw as unknown as WriteItem)
                continue
            case 'delete':
                assertDeleteItem(raw, itemCtx)
                out.push(raw as unknown as WriteItem)
                continue
            case 'upsert':
                assertUpsertItem(raw, itemCtx)
                out.push(raw as unknown as WriteItem)
                continue
        }
    }
    return out
}
