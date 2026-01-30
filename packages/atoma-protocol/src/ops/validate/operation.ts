import type { Operation, OperationKind, QueryOp, WriteAction, WriteOp, ChangesPullOp } from '../types'
import type { Meta } from '../../core/meta'
import { assertFiniteNumber, assertNonEmptyString, invalid, isObject, makeValidationDetails, requireObject, requireString, readString } from './common'
import { assertOpMeta } from './meta'
import { assertQuery } from './query'
import { assertWriteItems } from './write'

type JsonObject = Record<string, unknown>

type OpBase = {
    opId: string
    kind: OperationKind
    meta?: Meta
}

function assertOpBase(obj: JsonObject): OpBase {
    const detailsForOp = makeValidationDetails('op')
    const opId = requireString(obj, 'opId', {
        code: 'INVALID_REQUEST',
        message: 'Missing opId',
        details: detailsForOp('opId')
    })
    const kind = readString(obj, 'kind') as OperationKind | undefined
    if (kind !== 'query' && kind !== 'write' && kind !== 'changes.pull') {
        throw invalid('INVALID_REQUEST', 'Missing kind', detailsForOp('kind', { opId }))
    }
    const meta = assertOpMeta((obj as any).meta)
    return { opId, kind, ...(meta ? { meta } : {}) }
}

function assertQueryOp(obj: JsonObject, base: OpBase): QueryOp {
    const detailsForQuery = makeValidationDetails('query', { opId: base.opId })
    const queryObj = requireObject((obj as any).query, {
        code: 'INVALID_REQUEST',
        message: 'Missing query',
        details: detailsForQuery()
    })
    const resource = requireString(queryObj, 'resource', {
        code: 'INVALID_REQUEST',
        message: 'Missing query.resource',
        details: detailsForQuery('resource')
    })
    const query = assertQuery((queryObj as any).query, { opId: base.opId, resource })
    return {
        opId: base.opId,
        kind: 'query',
        ...(base.meta ? { meta: base.meta } : {}),
        query: { resource, query }
    }
}

function assertWriteOp(obj: JsonObject, base: OpBase): WriteOp {
    const detailsForWrite = makeValidationDetails('write', { opId: base.opId })
    const writeObj = requireObject((obj as any).write, {
        code: 'INVALID_REQUEST',
        message: 'Missing write',
        details: detailsForWrite()
    })
    const resource = requireString(writeObj, 'resource', {
        code: 'INVALID_REQUEST',
        message: 'Missing write.resource',
        details: detailsForWrite('resource')
    })
    const action = readString(writeObj, 'action') as WriteAction | undefined
    if (action !== 'create' && action !== 'update' && action !== 'delete' && action !== 'upsert') {
        throw invalid('INVALID_REQUEST', 'Invalid write.action', detailsForWrite('action', { resource }))
    }

    const items = assertWriteItems(action, (writeObj as any).items, { opId: base.opId, resource })
    const optionsRaw = (writeObj as any).options
    if (optionsRaw !== undefined && !isObject(optionsRaw)) {
        throw invalid('INVALID_WRITE', 'Invalid write.options', detailsForWrite('options', { resource }))
    }

    return {
        opId: base.opId,
        kind: 'write',
        ...(base.meta ? { meta: base.meta } : {}),
        write: {
            resource,
            action,
            items,
            ...(optionsRaw ? { options: optionsRaw as any } : {})
        }
    }
}

function assertChangesPullOp(obj: JsonObject, base: OpBase): ChangesPullOp {
    const detailsForPull = makeValidationDetails('pull', { opId: base.opId })
    const pullObj = requireObject((obj as any).pull, {
        code: 'INVALID_REQUEST',
        message: 'Missing pull',
        details: detailsForPull()
    })
    const cursor = (pullObj as any).cursor
    const limit = (pullObj as any).limit
    assertNonEmptyString(cursor, { code: 'INVALID_REQUEST', message: 'Missing pull.cursor', details: detailsForPull('cursor') })
    assertFiniteNumber(limit, { code: 'INVALID_REQUEST', message: 'Missing pull.limit', details: detailsForPull('limit') })

    const resourcesRaw = (pullObj as any).resources
    const resources = Array.isArray(resourcesRaw)
        ? resourcesRaw.filter((r: any) => typeof r === 'string' && r)
        : undefined

    return {
        opId: base.opId,
        kind: 'changes.pull',
        ...(base.meta ? { meta: base.meta } : {}),
        pull: {
            cursor: cursor as string,
            limit: limit as number,
            ...(resources?.length ? { resources } : {})
        }
    }
}

export function assertOperation(value: unknown): Operation {
    if (!isObject(value)) throw invalid('INVALID_REQUEST', 'Invalid op', { kind: 'validation', part: 'op' })

    const base = assertOpBase(value)

    switch (base.kind) {
        case 'query':
            return assertQueryOp(value, base)
        case 'write':
            return assertWriteOp(value, base)
        case 'changes.pull':
            return assertChangesPullOp(value, base)
    }
}
