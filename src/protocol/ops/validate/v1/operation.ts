import type { Operation, OperationKind, QueryOp, WriteAction, WriteOp, ChangesPullOp } from '../../types'
import type { Meta } from '../../../core/meta'
import { assertFiniteNumber, assertNonEmptyString, invalid, isObject, readString } from './common'
import { assertOpMeta } from './meta'
import { assertQueryParams } from './query'
import { assertWriteItems } from './write'

type JsonObject = Record<string, unknown>

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

    const baseMeta: Meta | undefined = meta

    return {
        opId,
        kind: 'changes.pull',
        ...(baseMeta ? { meta: baseMeta } : {}),
        pull: {
            cursor: cursor as string,
            limit: limit as number,
            ...(resources?.length ? { resources } : {})
        }
    } satisfies ChangesPullOp
}

