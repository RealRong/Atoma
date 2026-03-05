import type { RemoteOp, RemoteOpKind, QueryOp, WriteOp, Meta } from '@atoma-js/types/protocol'
import { invalid, isObject, makeValidationDetails, requireObject, requireString, readString } from './common'
import { assertOpMeta } from './meta'
import { assertQuery } from './query'
import { assertWriteEntries } from './write'

type JsonObject = Record<string, unknown>

type OpBase = {
    opId: string
    kind: RemoteOpKind
    meta?: Meta
}

function assertOpBase(obj: JsonObject): OpBase {
    const detailsForOp = makeValidationDetails('op')
    const opId = requireString(obj, 'opId', {
        code: 'INVALID_REQUEST',
        message: 'Missing opId',
        details: detailsForOp('opId')
    })
    const kind = readString(obj, 'kind') as RemoteOpKind | undefined
    if (kind !== 'query' && kind !== 'write') {
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

    const entries = assertWriteEntries((writeObj as any).entries, { opId: base.opId, resource })

    return {
        opId: base.opId,
        kind: 'write',
        ...(base.meta ? { meta: base.meta } : {}),
        write: {
            resource,
            entries
        }
    }
}

export function assertRemoteOp(value: unknown): RemoteOp {
    if (!isObject(value)) throw invalid('INVALID_REQUEST', 'Invalid op', { kind: 'validation', part: 'op' })

    const base = assertOpBase(value)

    switch (base.kind) {
        case 'query':
            return assertQueryOp(value, base)
        case 'write':
            return assertWriteOp(value, base)
    }
}
