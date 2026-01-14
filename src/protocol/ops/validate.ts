import type { Meta } from '../shared/meta'
import type { StandardError } from '../shared/error/types'
import { create as createStandardError } from '../shared/error/fns'
import type { Operation, OperationKind, QueryOp, WriteAction, WriteItem, WriteOp, ChangesPullOp } from './types'
import type { QueryParams } from './query'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return isObject(value)
}

function invalid(code: string, message: string, details?: Record<string, unknown>): StandardError {
    return createStandardError(code, message, details)
}

function readString(obj: JsonObject, key: string): string | undefined {
    const v = obj[key]
    return typeof v === 'string' ? v : undefined
}

function readNumber(obj: JsonObject, key: string): number | undefined {
    const v = obj[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function assertNonEmptyString(value: unknown, err: { code: string; message: string; details?: Record<string, unknown> }): string {
    if (typeof value !== 'string' || !value) throw invalid(err.code, err.message, err.details)
    return value
}

function assertFiniteNumber(value: unknown, err: { code: string; message: string; details?: Record<string, unknown> }): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(err.code, err.message, err.details)
    return value
}

function assertPositiveVersion(value: unknown, err: { code: string; message: string; details?: Record<string, unknown> }): number {
    const n = assertFiniteNumber(value, err)
    if (n <= 0) throw invalid(err.code, err.message, err.details)
    return n
}

function assertMetaV1(value: unknown): Meta {
    if (!isObject(value)) throw invalid('INVALID_REQUEST', 'Invalid meta', { kind: 'validation', part: 'meta' })
    const v = readNumber(value, 'v')
    if (v !== 1) {
        if (v === undefined) throw invalid('INVALID_REQUEST', 'Missing meta.v', { kind: 'validation', part: 'meta', field: 'v' })
        throw invalid('PROTOCOL_UNSUPPORTED_VERSION', 'Unsupported protocol version', { kind: 'validation', part: 'meta', supported: [1], received: v })
    }
    const deviceId = readString(value, 'deviceId')
    const traceId = readString(value, 'traceId')
    const requestId = readString(value, 'requestId')
    const clientTimeMs = readNumber(value, 'clientTimeMs')
    return {
        v,
        ...(deviceId ? { deviceId } : {}),
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(clientTimeMs !== undefined ? { clientTimeMs } : {})
    }
}

function assertOpMeta(value: unknown): Meta | undefined {
    if (!isObject(value)) return undefined
    const traceId = readString(value, 'traceId')
    const requestId = readString(value, 'requestId')
    if (!traceId && !requestId) return undefined
    const v = readNumber(value, 'v')
    return {
        v: v === undefined ? 1 : v,
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {})
    }
}

function assertQueryParams(value: unknown, ctx: { opId: string; resource: string }): QueryParams {
    if (!isObject(value)) throw invalid('INVALID_REQUEST', 'Missing query.params', { kind: 'validation', part: 'query', opId: ctx.opId, resource: ctx.resource })
    const params = value as QueryParams

    const where = (params as any).where
    if (where !== undefined && !isPlainObject(where)) {
        throw invalid('INVALID_QUERY', 'Invalid where (must be a plain object)', { kind: 'validation', part: 'query', field: 'where', opId: ctx.opId, resource: ctx.resource })
    }

    const orderBy = (params as any).orderBy
    if (orderBy !== undefined) {
        const arr = Array.isArray(orderBy) ? orderBy : [orderBy]
        if (!arr.length) {
            // allow empty (treated as missing)
        } else {
            for (const rule of arr) {
                if (!isObject(rule)) {
                    throw invalid('INVALID_ORDER_BY', 'Invalid orderBy rule', { kind: 'validation', part: 'query', field: 'orderBy', opId: ctx.opId, resource: ctx.resource })
                }
                const field = (rule as any).field
                const direction = (rule as any).direction
                if (typeof field !== 'string' || !field || (direction !== 'asc' && direction !== 'desc')) {
                    throw invalid('INVALID_ORDER_BY', 'Invalid orderBy rule', { kind: 'validation', part: 'query', field: 'orderBy', opId: ctx.opId, resource: ctx.resource })
                }
            }
        }
    }

    const fields = (params as any).fields
    if (fields !== undefined) {
        if (!Array.isArray(fields) || fields.some(f => typeof f !== 'string' || !f)) {
            throw invalid('INVALID_QUERY', 'Invalid fields', { kind: 'validation', part: 'query', field: 'fields', opId: ctx.opId, resource: ctx.resource })
        }
    }

    const limit = (params as any).limit
    if (limit !== undefined) {
        const n = assertFiniteNumber(limit, { code: 'INVALID_QUERY', message: 'Invalid limit', details: { kind: 'validation', part: 'query', field: 'limit', opId: ctx.opId, resource: ctx.resource } })
        if (n < 0) throw invalid('INVALID_QUERY', 'Invalid limit', { kind: 'validation', part: 'query', field: 'limit', opId: ctx.opId, resource: ctx.resource })
    }
    const offset = (params as any).offset
    if (offset !== undefined) {
        const n = assertFiniteNumber(offset, { code: 'INVALID_QUERY', message: 'Invalid offset', details: { kind: 'validation', part: 'query', field: 'offset', opId: ctx.opId, resource: ctx.resource } })
        if (n < 0) throw invalid('INVALID_QUERY', 'Invalid offset', { kind: 'validation', part: 'query', field: 'offset', opId: ctx.opId, resource: ctx.resource })
    }
    const includeTotal = (params as any).includeTotal
    if (includeTotal !== undefined && typeof includeTotal !== 'boolean') {
        throw invalid('INVALID_QUERY', 'Invalid includeTotal', { kind: 'validation', part: 'query', field: 'includeTotal', opId: ctx.opId, resource: ctx.resource })
    }
    const after = (params as any).after
    if (after !== undefined && (typeof after !== 'string' || !after)) {
        throw invalid('INVALID_QUERY', 'Invalid after', { kind: 'validation', part: 'query', field: 'after', opId: ctx.opId, resource: ctx.resource })
    }
    const before = (params as any).before
    if (before !== undefined && (typeof before !== 'string' || !before)) {
        throw invalid('INVALID_QUERY', 'Invalid before', { kind: 'validation', part: 'query', field: 'before', opId: ctx.opId, resource: ctx.resource })
    }

    return params
}

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

function assertWriteItems(action: WriteAction, value: unknown, ctx: { opId: string; resource: string }): WriteItem[] {
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

export function assertOperationV1(value: unknown): Operation {
    if (!isObject(value)) throw invalid('INVALID_REQUEST', 'Invalid op', { kind: 'validation', part: 'op' })

    const opId = readString(value, 'opId')
    if (!opId) throw invalid('INVALID_REQUEST', 'Missing opId', { kind: 'validation', part: 'op', field: 'opId' })
    const kind = readString(value, 'kind') as OperationKind | undefined
    if (kind !== 'query' && kind !== 'write' && kind !== 'changes.pull') {
        throw invalid('INVALID_REQUEST', 'Missing kind', { kind: 'validation', part: 'op', field: 'kind', opId })
    }

    const meta = assertOpMeta((value as any).meta)

    if (kind === 'query') {
        if (!isObject((value as any).query)) throw invalid('INVALID_REQUEST', 'Missing query', { kind: 'validation', part: 'query', opId })
        const queryObj = (value as any).query as JsonObject
        const resource = readString(queryObj, 'resource')
        if (!resource) throw invalid('INVALID_REQUEST', 'Missing query.resource', { kind: 'validation', part: 'query', field: 'resource', opId })
        const params = assertQueryParams(queryObj.params, { opId, resource })
        return {
            opId,
            kind: 'query',
            ...(meta ? { meta } : {}),
            query: {
                resource,
                params
            }
        } satisfies QueryOp
    }

    if (kind === 'write') {
        if (!isObject((value as any).write)) throw invalid('INVALID_REQUEST', 'Missing write', { kind: 'validation', part: 'write', opId })
        const writeObj = (value as any).write as JsonObject
        const resource = readString(writeObj, 'resource')
        if (!resource) throw invalid('INVALID_REQUEST', 'Missing write.resource', { kind: 'validation', part: 'write', field: 'resource', opId })
        const action = readString(writeObj, 'action') as WriteAction | undefined
        if (action !== 'create' && action !== 'update' && action !== 'delete' && action !== 'upsert') {
            throw invalid('INVALID_REQUEST', 'Invalid write.action', { kind: 'validation', part: 'write', field: 'action', opId, resource })
        }
        const items = assertWriteItems(action, writeObj.items, { opId, resource })
        const optionsRaw = writeObj.options
        if (optionsRaw !== undefined && !isObject(optionsRaw)) {
            throw invalid('INVALID_WRITE', 'Invalid write.options', { kind: 'validation', part: 'write', field: 'options', opId, resource })
        }
        return {
            opId,
            kind: 'write',
            ...(meta ? { meta } : {}),
            write: {
                resource,
                action,
                items,
                ...(optionsRaw ? { options: optionsRaw as any } : {})
            }
        } satisfies WriteOp
    }

    // changes.pull
    if (!isObject((value as any).pull)) throw invalid('INVALID_REQUEST', 'Missing pull', { kind: 'validation', part: 'pull', opId })
    const pullObj = (value as any).pull as JsonObject
    const cursor = pullObj.cursor
    const limit = pullObj.limit
    assertNonEmptyString(cursor, { code: 'INVALID_REQUEST', message: 'Missing pull.cursor', details: { kind: 'validation', part: 'pull', field: 'cursor', opId } })
    assertFiniteNumber(limit, { code: 'INVALID_REQUEST', message: 'Missing pull.limit', details: { kind: 'validation', part: 'pull', field: 'limit', opId } })

    const resourcesRaw = (pullObj as any).resources
    const resources = Array.isArray(resourcesRaw)
        ? resourcesRaw.filter((r: any) => typeof r === 'string' && r)
        : undefined

    return {
        opId,
        kind: 'changes.pull',
        ...(meta ? { meta } : {}),
        pull: {
            cursor: cursor as string,
            limit: limit as number,
            ...(resources?.length ? { resources } : {})
        }
    } satisfies ChangesPullOp
}

export function assertOpsRequestV1(value: unknown): { meta: Meta; ops: Operation[] } {
    if (!isObject(value)) throw invalid('INVALID_REQUEST', 'Invalid body', { kind: 'validation', part: 'body' })
    const meta = assertMetaV1((value as any).meta)
    const opsRaw = (value as any).ops
    if (!Array.isArray(opsRaw)) throw invalid('INVALID_REQUEST', 'Missing ops', { kind: 'validation', part: 'body', field: 'ops' })
    const ops = opsRaw.map(op => assertOperationV1(op))
    return { meta, ops }
}

export function assertOutgoingOpsV1(args: { meta: Meta; ops: Operation[] }) {
    assertMetaV1(args.meta)
    if (!Array.isArray(args.ops)) throw invalid('INVALID_REQUEST', 'Missing ops', { kind: 'validation', part: 'body', field: 'ops' })
    args.ops.forEach(op => { void assertOperationV1(op) })
}

