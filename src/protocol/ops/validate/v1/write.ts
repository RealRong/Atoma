import type { WriteAction, WriteItem } from '../../types'
import { assertFiniteNumber, assertNonEmptyString, assertPositiveVersion, invalid, isObject } from './common'

function assertWriteItemMeta(value: unknown, ctx: { opId: string; resource: string; action: WriteAction; index: number }) {
    if (!isObject(value)) {
        throw invalid('INVALID_WRITE', 'Missing write item meta', { kind: 'validation', part: 'write', field: 'meta', opId: ctx.opId, resource: ctx.resource, index: ctx.index, action: ctx.action })
    }
    const idempotencyKey = (value as any).idempotencyKey
    const clientTimeMs = (value as any).clientTimeMs
    assertNonEmptyString(idempotencyKey, {
        code: 'INVALID_WRITE',
        message: 'Missing meta.idempotencyKey',
        details: { kind: 'validation', part: 'write', field: 'meta.idempotencyKey', opId: ctx.opId, resource: ctx.resource, index: ctx.index, action: ctx.action }
    })
    assertFiniteNumber(clientTimeMs, {
        code: 'INVALID_WRITE',
        message: 'Missing meta.clientTimeMs',
        details: { kind: 'validation', part: 'write', field: 'meta.clientTimeMs', opId: ctx.opId, resource: ctx.resource, index: ctx.index, action: ctx.action }
    })
}

function assertWriteItemValue(value: unknown, ctx: { opId: string; resource: string; action: WriteAction; index: number }): Record<string, unknown> {
    if (!isObject(value)) {
        throw invalid('INVALID_WRITE', 'Invalid write item value (must be an object)', { kind: 'validation', part: 'write', field: 'value', opId: ctx.opId, resource: ctx.resource, index: ctx.index, action: ctx.action })
    }
    return value
}

function assertEntityIdString(value: unknown, ctx: { opId: string; resource: string; action: WriteAction; index: number }): string {
    return assertNonEmptyString(value, {
        code: 'INVALID_WRITE',
        message: 'Missing entityId',
        details: { kind: 'validation', part: 'write', field: 'entityId', opId: ctx.opId, resource: ctx.resource, index: ctx.index, action: ctx.action }
    })
}

function assertValueIdMatchesEntityId(args: { entityId?: string; value: Record<string, unknown>; opId: string; resource: string; action: WriteAction; index: number }) {
    if (!Object.prototype.hasOwnProperty.call(args.value, 'id')) return
    const id = (args.value as any).id
    if (typeof id !== 'string' || !id) {
        throw invalid('INVALID_WRITE', 'Invalid value.id (must be a non-empty string)', {
            kind: 'validation',
            part: 'write',
            field: 'value.id',
            opId: args.opId,
            resource: args.resource,
            index: args.index,
            action: args.action
        })
    }
    if (args.entityId && id !== args.entityId) {
        throw invalid('INVALID_WRITE', 'value.id must match entityId', {
            kind: 'validation',
            part: 'write',
            field: 'value.id',
            opId: args.opId,
            resource: args.resource,
            index: args.index,
            action: args.action
        })
    }
}

export function assertWriteItems(action: WriteAction, value: unknown, ctx: { opId: string; resource: string }): WriteItem[] {
    if (!Array.isArray(value)) throw invalid('INVALID_REQUEST', 'Missing write.items', { kind: 'validation', part: 'write', opId: ctx.opId, resource: ctx.resource })
    const out: WriteItem[] = []
    for (let index = 0; index < value.length; index++) {
        const raw = value[index]
        if (!isObject(raw)) {
            throw invalid('INVALID_WRITE', 'Invalid write item', { kind: 'validation', part: 'write', opId: ctx.opId, resource: ctx.resource, index, action })
        }

        const itemCtx = { opId: ctx.opId, resource: ctx.resource, action, index }
        const meta = (raw as any).meta
        assertWriteItemMeta(meta, itemCtx)

        if (action === 'create') {
            const entityId = (raw as any).entityId
            if (entityId !== undefined && entityId !== null) {
                assertEntityIdString(entityId, itemCtx)
            }
            const val = assertWriteItemValue((raw as any).value, itemCtx)
            if (entityId === undefined || entityId === null) {
                if (Object.prototype.hasOwnProperty.call(val, 'id') && (val as any).id !== undefined && (val as any).id !== null) {
                    throw invalid('INVALID_WRITE', 'server-assigned create must not include value.id', {
                        kind: 'validation',
                        part: 'write',
                        field: 'value.id',
                        opId: ctx.opId,
                        resource: ctx.resource,
                        index,
                        action
                    })
                }
            }
            assertValueIdMatchesEntityId({ entityId: typeof entityId === 'string' ? entityId : undefined, value: val, ...itemCtx })
            out.push(raw as unknown as WriteItem)
            continue
        }

        if (action === 'update') {
            const entityId = assertEntityIdString((raw as any).entityId, itemCtx)
            assertPositiveVersion((raw as any).baseVersion, {
                code: 'INVALID_WRITE',
                message: 'Missing baseVersion',
                details: { kind: 'validation', part: 'write', field: 'baseVersion', opId: ctx.opId, resource: ctx.resource, index, action }
            })
            const val = assertWriteItemValue((raw as any).value, itemCtx)
            assertValueIdMatchesEntityId({ entityId, value: val, ...itemCtx })
            out.push(raw as unknown as WriteItem)
            continue
        }

        if (action === 'delete') {
            assertEntityIdString((raw as any).entityId, itemCtx)
            assertPositiveVersion((raw as any).baseVersion, {
                code: 'INVALID_WRITE',
                message: 'Missing baseVersion',
                details: { kind: 'validation', part: 'write', field: 'baseVersion', opId: ctx.opId, resource: ctx.resource, index, action }
            })
            out.push(raw as unknown as WriteItem)
            continue
        }

        if (action === 'upsert') {
            const entityId = assertEntityIdString((raw as any).entityId, itemCtx)
            const baseVersion = (raw as any).baseVersion
            if (baseVersion !== undefined && baseVersion !== null) {
                assertPositiveVersion(baseVersion, {
                    code: 'INVALID_WRITE',
                    message: 'Invalid baseVersion',
                    details: { kind: 'validation', part: 'write', field: 'baseVersion', opId: ctx.opId, resource: ctx.resource, index, action }
                })
            }
            const val = assertWriteItemValue((raw as any).value, itemCtx)
            assertValueIdMatchesEntityId({ entityId, value: val, ...itemCtx })
            out.push(raw as unknown as WriteItem)
            continue
        }
    }
    return out
}

