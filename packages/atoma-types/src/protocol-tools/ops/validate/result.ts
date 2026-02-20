import type { RemoteOpResult, QueryResultData, StandardError, WriteItemResult, WriteResultData } from 'atoma-types/protocol'
import { assertPositiveVersion, invalid, isObject, makeValidationDetails, requireArray, requireObject, requireString } from './common'

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

export function assertRemoteOpResult(value: unknown): RemoteOpResult {
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
        return obj as unknown as RemoteOpResult
    }

    const error = (obj as any).error
    assertStandardError(error, { part: 'opResult', field: 'error' })
    return obj as unknown as RemoteOpResult
}

export function assertRemoteOpResults(value: unknown): RemoteOpResult[] {
    const detailsFor = makeValidationDetails('opsResponse')
    const arr = requireArray(value, { code: 'INVALID_RESPONSE', message: 'Invalid results (must be an array)', details: detailsFor('results') })
    return arr.map(r => assertRemoteOpResult(r))
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

    const entryId = requireString(value, 'entryId', {
        code: 'INVALID_RESPONSE',
        message: 'Invalid write item result (missing entryId)',
        details: detailsFor('entryId')
    })

    const ok = (value as any).ok
    if (ok !== true && ok !== false) {
        throw invalid('INVALID_RESPONSE', 'Invalid write item result (missing ok)', detailsFor('ok', { entryId }))
    }

    if (ok === true) {
        const id = (value as any).id
        if (typeof id !== 'string' || !id) {
            throw invalid('INVALID_RESPONSE', 'Invalid write item result (missing id)', detailsFor('id', { entryId }))
        }
        assertPositiveVersion((value as any).version, {
            code: 'INVALID_RESPONSE',
            message: 'Invalid write item result (missing version)',
            details: detailsFor('version', { entryId })
        })
        return value as unknown as WriteItemResult
    }

    assertStandardError((value as any).error, { part: 'writeResult', field: 'error' })
    const current = (value as any).current
    if (current !== undefined) {
        if (!isObject(current)) throw invalid('INVALID_RESPONSE', 'Invalid write item result (invalid current)', detailsFor('current', { entryId }))
        const currentVersion = (current as any).version
        if (currentVersion !== undefined && currentVersion !== null) {
            assertPositiveVersion(currentVersion, {
                code: 'INVALID_RESPONSE',
                message: 'Invalid write item result (invalid current.version)',
                details: detailsFor('current.version', { entryId })
            })
        }
    }
    return value as unknown as WriteItemResult
}

export function assertWriteResultData(
    value: unknown,
    options?: Readonly<{
        expectedLength?: number
        expectedEntryIds?: ReadonlyArray<string>
    }>
): WriteResultData {
    const detailsFor = makeValidationDetails('writeResult')
    if (!isObject(value)) throw invalid('INVALID_RESPONSE', 'Invalid write result data', detailsFor())
    const results = (value as any).results
    if (!Array.isArray(results)) {
        throw invalid('INVALID_RESPONSE', 'Invalid write result data (missing results)', detailsFor('results'))
    }
    results.forEach((r, index) => {
        const item = assertWriteItemResult(r)
        const expectedEntryId = options?.expectedEntryIds?.[index]
        if (expectedEntryId !== undefined && item.entryId !== expectedEntryId) {
            throw invalid(
                'INVALID_RESPONSE',
                'Invalid write result data (entryId mismatch)',
                detailsFor(`results[${index}].entryId`, { expectedEntryId, actualEntryId: item.entryId })
            )
        }
    })
    if (typeof options?.expectedLength === 'number' && results.length !== options.expectedLength) {
        throw invalid(
            'INVALID_RESPONSE',
            'Invalid write result data (results length mismatch)',
            detailsFor('results', { expectedLength: options.expectedLength, actualLength: results.length })
        )
    }
    const transactionApplied = (value as any).transactionApplied
    if (transactionApplied !== undefined && typeof transactionApplied !== 'boolean') {
        throw invalid('INVALID_RESPONSE', 'Invalid write result data (invalid transactionApplied)', detailsFor('transactionApplied'))
    }
    return value as unknown as WriteResultData
}
