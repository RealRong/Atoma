import type { StandardError } from '../../core/error'
import type { OperationResult, QueryResultData, WriteItemResult, WriteResultData } from '../types'
import { assertFiniteNumber, assertPositiveVersion, invalid, isObject, makeValidationDetails, requireArray, requireObject, requireString, readString } from './common'

function assertStandardError(value: unknown, ctx: { part: string; field?: string }): StandardError {
    const detailsFor = makeValidationDetails(ctx.part)
    const obj = requireObject(value, {
        code: 'INVALID_RESPONSE',
        message: 'Invalid error',
        details: detailsFor(ctx.field)
    })
    requireString(obj, 'code', { code: 'INVALID_RESPONSE', message: 'Invalid error', details: detailsFor(ctx.field) })
    requireString(obj, 'message', { code: 'INVALID_RESPONSE', message: 'Invalid error', details: detailsFor(ctx.field) })
    requireString(obj, 'kind', { code: 'INVALID_RESPONSE', message: 'Invalid error', details: detailsFor(ctx.field) })
    return obj as unknown as StandardError
}

export function assertOperationResult(value: unknown): OperationResult {
    const detailsFor = makeValidationDetails('opResult')
    const obj = requireObject(value, { code: 'INVALID_RESPONSE', message: 'Invalid operation result', details: detailsFor() })

    const opId = requireString(obj, 'opId', {
        code: 'INVALID_RESPONSE',
        message: 'Invalid operation result (missing opId)',
        details: detailsFor('opId')
    })

    const ok = (obj as any).ok
    if (ok !== true && ok !== false) {
        throw invalid('INVALID_RESPONSE', 'Invalid operation result (missing ok)', detailsFor('ok', { opId }))
    }

    if (ok === true) {
        if (!Object.prototype.hasOwnProperty.call(obj, 'data')) {
            throw invalid('INVALID_RESPONSE', 'Invalid operation result (missing data)', detailsFor('data', { opId }))
        }
        return obj as unknown as OperationResult
    }

    const error = (obj as any).error
    assertStandardError(error, { part: 'opResult', field: 'error' })
    return obj as unknown as OperationResult
}

export function assertOperationResults(value: unknown): OperationResult[] {
    const detailsFor = makeValidationDetails('opsResponse')
    const arr = requireArray(value, { code: 'INVALID_RESPONSE', message: 'Invalid results (must be an array)', details: detailsFor('results') })
    return arr.map(r => assertOperationResult(r))
}

export function assertQueryResultData(value: unknown): QueryResultData {
    const detailsFor = makeValidationDetails('queryResult')
    const obj = requireObject(value, { code: 'INVALID_RESPONSE', message: 'Invalid query result data', details: detailsFor() })
    const data = (obj as any).data
    if (!Array.isArray(data)) {
        throw invalid('INVALID_RESPONSE', 'Invalid query result data (missing data)', detailsFor('data'))
    }
    return obj as unknown as QueryResultData
}

function assertWriteItemResult(value: unknown): WriteItemResult {
    const detailsFor = makeValidationDetails('writeResult')
    if (!isObject(value)) throw invalid('INVALID_RESPONSE', 'Invalid write item result', detailsFor())

    const index = assertFiniteNumber((value as any).index, {
        code: 'INVALID_RESPONSE',
        message: 'Invalid write item result (missing index)',
        details: detailsFor('index')
    })
    const ok = (value as any).ok
    if (ok !== true && ok !== false) {
        throw invalid('INVALID_RESPONSE', 'Invalid write item result (missing ok)', detailsFor('ok', { index }))
    }

    if (ok === true) {
        const entityId = (value as any).entityId
        if (typeof entityId !== 'string' || !entityId) {
            throw invalid('INVALID_RESPONSE', 'Invalid write item result (missing entityId)', detailsFor('entityId', { index }))
        }
        assertPositiveVersion((value as any).version, {
            code: 'INVALID_RESPONSE',
            message: 'Invalid write item result (missing version)',
            details: detailsFor('version', { index })
        })
        return value as unknown as WriteItemResult
    }

    assertStandardError((value as any).error, { part: 'writeResult', field: 'error' })
    const current = (value as any).current
    if (current !== undefined) {
        if (!isObject(current)) throw invalid('INVALID_RESPONSE', 'Invalid write item result (invalid current)', detailsFor('current', { index }))
        const currentVersion = (current as any).version
        if (currentVersion !== undefined && currentVersion !== null) {
            assertPositiveVersion(currentVersion, {
                code: 'INVALID_RESPONSE',
                message: 'Invalid write item result (invalid current.version)',
                details: detailsFor('current.version', { index })
            })
        }
    }
    return value as unknown as WriteItemResult
}

export function assertWriteResultData(value: unknown): WriteResultData {
    const detailsFor = makeValidationDetails('writeResult')
    if (!isObject(value)) throw invalid('INVALID_RESPONSE', 'Invalid write result data', detailsFor())
    const results = (value as any).results
    if (!Array.isArray(results)) {
        throw invalid('INVALID_RESPONSE', 'Invalid write result data (missing results)', detailsFor('results'))
    }
    results.forEach(r => { void assertWriteItemResult(r) })
    const transactionApplied = (value as any).transactionApplied
    if (transactionApplied !== undefined && typeof transactionApplied !== 'boolean') {
        throw invalid('INVALID_RESPONSE', 'Invalid write result data (invalid transactionApplied)', detailsFor('transactionApplied'))
    }
    return value as unknown as WriteResultData
}
