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

function assertIdString(value: unknown, ctx: WriteEntryCtx): string {
    return assertNonEmptyString(value, {
        code: 'INVALID_WRITE',
        message: 'Missing item.id',
        details: detailsForWrite(ctx, 'item.id')
    })
}

function assertValueIdMatchesId(args: { id?: string; value: Record<string, unknown> } & WriteEntryCtx) {
    if (!Object.prototype.hasOwnProperty.call(args.value, 'id')) return
    const id = (args.value as any).id
    if (typeof id !== 'string' || !id) {
        throw invalid('INVALID_WRITE', 'Invalid item.value.id (must be a non-empty string)', detailsForWrite(args, 'item.value.id'))
    }
    if (args.id && id !== args.id) {
        throw invalid('INVALID_WRITE', 'item.value.id must match item.id', detailsForWrite(args, 'item.value.id'))
    }
}

function assertCreateItem(raw: Record<string, unknown>, ctx: WriteEntryCtx) {
    const id = (raw as any).id
    if (id !== undefined && id !== null) {
        assertIdString(id, ctx)
    }

    const val = assertWriteItemValue((raw as any).value, ctx)

    if (id === undefined || id === null) {
        if (Object.prototype.hasOwnProperty.call(val, 'id') && (val as any).id !== undefined && (val as any).id !== null) {
            throw invalid('INVALID_WRITE', 'server-assigned create must not include item.value.id', detailsForWrite(ctx, 'item.value.id'))
        }
    }

    assertValueIdMatchesId({ id: typeof id === 'string' ? id : undefined, value: val, ...ctx })
}

function assertUpdateItem(raw: Record<string, unknown>, ctx: WriteEntryCtx) {
    const id = assertIdString((raw as any).id, ctx)
    assertPositiveVersion((raw as any).baseVersion, {
        code: 'INVALID_WRITE',
        message: 'Missing item.baseVersion',
        details: detailsForWrite(ctx, 'item.baseVersion')
    })
    const val = assertWriteItemValue((raw as any).value, ctx)
    assertValueIdMatchesId({ id, value: val, ...ctx })
}

function assertDeleteItem(raw: Record<string, unknown>, ctx: WriteEntryCtx) {
    assertIdString((raw as any).id, ctx)
    assertPositiveVersion((raw as any).baseVersion, {
        code: 'INVALID_WRITE',
        message: 'Missing item.baseVersion',
        details: detailsForWrite(ctx, 'item.baseVersion')
    })
}

function assertUpsertItem(raw: Record<string, unknown>, ctx: WriteEntryCtx) {
    const id = assertIdString((raw as any).id, ctx)
    if ((raw as any).baseVersion !== undefined) {
        throw invalid('INVALID_WRITE', 'item.baseVersion is not supported', detailsForWrite(ctx, 'item.baseVersion'))
    }
    const expectedVersion = (raw as any).expectedVersion
    if (expectedVersion !== undefined && expectedVersion !== null) {
        assertPositiveVersion(expectedVersion, {
            code: 'INVALID_WRITE',
            message: 'Invalid item.expectedVersion',
            details: detailsForWrite(ctx, 'item.expectedVersion')
        })
    }
    const val = assertWriteItemValue((raw as any).value, ctx)
    assertValueIdMatchesId({ id, value: val, ...ctx })
}

function assertWriteOptions(raw: Record<string, unknown>, ctx: WriteEntryCtx): WriteOptions {
    if ((raw as any).merge !== undefined) {
        throw invalid('INVALID_WRITE', 'options.merge is not supported', detailsForWrite(ctx, 'options.merge'))
    }

    const upsert = (raw as any).upsert
    if (upsert !== undefined && upsert !== null) {
        if (!isObject(upsert)) {
            throw invalid('INVALID_WRITE', 'Invalid options.upsert', detailsForWrite(ctx, 'options.upsert'))
        }

        const conflict = (upsert as any).conflict
        if (conflict !== undefined && conflict !== 'cas' && conflict !== 'lww') {
            throw invalid('INVALID_WRITE', 'Invalid options.upsert.conflict', detailsForWrite(ctx, 'options.upsert.conflict'))
        }

        if ((upsert as any).mode !== undefined) {
            throw invalid('INVALID_WRITE', 'options.upsert.mode is not supported', detailsForWrite(ctx, 'options.upsert.mode'))
        }

        const apply = (upsert as any).apply
        if (apply !== undefined && apply !== 'merge' && apply !== 'replace') {
            throw invalid('INVALID_WRITE', 'Invalid options.upsert.apply', detailsForWrite(ctx, 'options.upsert.apply'))
        }
    }

    return raw as WriteOptions
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
    const options = optionsRaw ? assertWriteOptions(optionsRaw, entryCtx) : undefined

    return {
        entryId,
        action,
        item: item as unknown as WriteItem,
        ...(options ? { options } : {})
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
