import type { ResourceToken, WriteAction, WriteEntry, WriteItem, WriteOptions } from 'atoma-types/protocol'
import { assertFiniteNumber, assertNonEmptyString, assertPositiveVersion, invalid, isObject, makeValidationDetails } from './common'

type WriteEntryCtx = {
    opId: string
    resource: ResourceToken
    entryId: string
    action: WriteAction
}

function detailsForWrite(ctx: WriteEntryCtx, field?: string) {
    return makeValidationDetails('write', {
        opId: ctx.opId,
        resource: ctx.resource,
        entryId: ctx.entryId,
        action: ctx.action
    })(field)
}

function assertWriteItemMeta(value: unknown, ctx: WriteEntryCtx) {
    if (!isObject(value)) {
        throw invalid('INVALID_WRITE', 'Missing write item meta', detailsForWrite(ctx, 'item.meta'))
    }
    const idempotencyKey = (value as any).idempotencyKey
    const clientTimeMs = (value as any).clientTimeMs
    assertNonEmptyString(idempotencyKey, {
        code: 'INVALID_WRITE',
        message: 'Missing item.meta.idempotencyKey',
        details: detailsForWrite(ctx, 'item.meta.idempotencyKey')
    })
    assertFiniteNumber(clientTimeMs, {
        code: 'INVALID_WRITE',
        message: 'Missing item.meta.clientTimeMs',
        details: detailsForWrite(ctx, 'item.meta.clientTimeMs')
    })
}

function assertWriteItemValue(value: unknown, ctx: WriteEntryCtx): Record<string, unknown> {
    if (!isObject(value)) {
        throw invalid('INVALID_WRITE', 'Invalid write item value (must be an object)', detailsForWrite(ctx, 'item.value'))
    }
    return value
}

function assertEntityIdString(value: unknown, ctx: WriteEntryCtx): string {
    return assertNonEmptyString(value, {
        code: 'INVALID_WRITE',
        message: 'Missing item.entityId',
        details: detailsForWrite(ctx, 'item.entityId')
    })
}

function assertValueIdMatchesEntityId(args: { entityId?: string; value: Record<string, unknown> } & WriteEntryCtx) {
    if (!Object.prototype.hasOwnProperty.call(args.value, 'id')) return
    const id = (args.value as any).id
    if (typeof id !== 'string' || !id) {
        throw invalid('INVALID_WRITE', 'Invalid item.value.id (must be a non-empty string)', detailsForWrite(args, 'item.value.id'))
    }
    if (args.entityId && id !== args.entityId) {
        throw invalid('INVALID_WRITE', 'item.value.id must match item.entityId', detailsForWrite(args, 'item.value.id'))
    }
}

function assertCreateItem(raw: Record<string, unknown>, ctx: WriteEntryCtx) {
    const entityId = (raw as any).entityId
    if (entityId !== undefined && entityId !== null) {
        assertEntityIdString(entityId, ctx)
    }

    const val = assertWriteItemValue((raw as any).value, ctx)

    if (entityId === undefined || entityId === null) {
        if (Object.prototype.hasOwnProperty.call(val, 'id') && (val as any).id !== undefined && (val as any).id !== null) {
            throw invalid('INVALID_WRITE', 'server-assigned create must not include item.value.id', detailsForWrite(ctx, 'item.value.id'))
        }
    }

    assertValueIdMatchesEntityId({ entityId: typeof entityId === 'string' ? entityId : undefined, value: val, ...ctx })
}

function assertUpdateItem(raw: Record<string, unknown>, ctx: WriteEntryCtx) {
    const entityId = assertEntityIdString((raw as any).entityId, ctx)
    assertPositiveVersion((raw as any).baseVersion, {
        code: 'INVALID_WRITE',
        message: 'Missing item.baseVersion',
        details: detailsForWrite(ctx, 'item.baseVersion')
    })
    const val = assertWriteItemValue((raw as any).value, ctx)
    assertValueIdMatchesEntityId({ entityId, value: val, ...ctx })
}

function assertDeleteItem(raw: Record<string, unknown>, ctx: WriteEntryCtx) {
    assertEntityIdString((raw as any).entityId, ctx)
    assertPositiveVersion((raw as any).baseVersion, {
        code: 'INVALID_WRITE',
        message: 'Missing item.baseVersion',
        details: detailsForWrite(ctx, 'item.baseVersion')
    })
}

function assertUpsertItem(raw: Record<string, unknown>, ctx: WriteEntryCtx) {
    const entityId = assertEntityIdString((raw as any).entityId, ctx)
    const baseVersion = (raw as any).baseVersion
    if (baseVersion !== undefined && baseVersion !== null) {
        assertPositiveVersion(baseVersion, {
            code: 'INVALID_WRITE',
            message: 'Invalid item.baseVersion',
            details: detailsForWrite(ctx, 'item.baseVersion')
        })
    }
    const val = assertWriteItemValue((raw as any).value, ctx)
    assertValueIdMatchesEntityId({ entityId, value: val, ...ctx })
}

function assertWriteAction(value: unknown, ctx: { opId: string; resource: ResourceToken; entryId: string }): WriteAction {
    const action = typeof value === 'string' ? value : undefined
    if (action !== 'create' && action !== 'update' && action !== 'delete' && action !== 'upsert') {
        throw invalid('INVALID_REQUEST', 'Invalid write entry action', {
            kind: 'validation',
            part: 'write',
            opId: ctx.opId,
            resource: ctx.resource,
            entryId: ctx.entryId,
            field: 'action'
        })
    }
    return action
}

function assertWriteEntry(value: unknown, ctx: { opId: string; resource: ResourceToken }): WriteEntry {
    if (!isObject(value)) {
        throw invalid('INVALID_WRITE', 'Invalid write entry', {
            kind: 'validation',
            part: 'write',
            opId: ctx.opId,
            resource: ctx.resource
        })
    }

    const entryId = assertNonEmptyString((value as any).entryId, {
        code: 'INVALID_WRITE',
        message: 'Missing write entryId',
        details: makeValidationDetails('write', { opId: ctx.opId, resource: ctx.resource })('entryId')
    })

    const action = assertWriteAction((value as any).action, { ...ctx, entryId })
    const item = (value as any).item
    if (!isObject(item)) {
        throw invalid('INVALID_WRITE', 'Missing write entry item', {
            kind: 'validation',
            part: 'write',
            opId: ctx.opId,
            resource: ctx.resource,
            entryId,
            action,
            field: 'item'
        })
    }

    const entryCtx: WriteEntryCtx = { ...ctx, entryId, action }

    assertWriteItemMeta((item as any).meta, entryCtx)

    switch (action) {
        case 'create':
            assertCreateItem(item, entryCtx)
            break
        case 'update':
            assertUpdateItem(item, entryCtx)
            break
        case 'delete':
            assertDeleteItem(item, entryCtx)
            break
        case 'upsert':
            assertUpsertItem(item, entryCtx)
            break
    }

    const optionsRaw = (value as any).options
    if (optionsRaw !== undefined && !isObject(optionsRaw)) {
        throw invalid('INVALID_WRITE', 'Invalid write entry options', detailsForWrite(entryCtx, 'options'))
    }

    return {
        entryId,
        action,
        item: item as unknown as WriteItem,
        ...(optionsRaw ? { options: optionsRaw as WriteOptions } : {})
    } as WriteEntry
}

export function assertWriteEntries(value: unknown, ctx: { opId: string; resource: ResourceToken }): WriteEntry[] {
    if (!Array.isArray(value)) {
        throw invalid('INVALID_REQUEST', 'Missing write.entries', {
            kind: 'validation',
            part: 'write',
            opId: ctx.opId,
            resource: ctx.resource
        })
    }

    const out: WriteEntry[] = []
    for (let index = 0; index < value.length; index++) {
        try {
            out.push(assertWriteEntry(value[index], ctx))
        } catch (error) {
            if (isObject(error) && typeof (error as any).code === 'string') {
                throw error
            }
            throw invalid('INVALID_WRITE', 'Invalid write entry', {
                kind: 'validation',
                part: 'write',
                opId: ctx.opId,
                resource: ctx.resource,
                index
            })
        }
    }

    return out
}
