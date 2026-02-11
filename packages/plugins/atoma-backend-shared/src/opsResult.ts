import type { ErrorKind, QueryResultData, StandardError, WriteEntry, WriteItemResult } from 'atoma-types/protocol'
import { assertQueryResultData, assertRemoteOpResults, assertWriteResultData } from 'atoma-types/protocol-tools'

const ERROR_KIND_SET = new Set<ErrorKind>([
    'validation',
    'auth',
    'limits',
    'conflict',
    'not_found',
    'adapter',
    'internal'
])

function isErrorKind(value: unknown): value is ErrorKind {
    return typeof value === 'string' && ERROR_KIND_SET.has(value as ErrorKind)
}

function toErrorDetails(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined
    }
    return value as Record<string, unknown>
}

function toStandardError(value: unknown): StandardError {
    if (!value || typeof value !== 'object') {
        return {
            code: 'WRITE_FAILED',
            message: '[Atoma] write op failed',
            kind: 'internal'
        }
    }

    const candidate = value as {
        code?: unknown
        message?: unknown
        kind?: unknown
        details?: unknown
        retryable?: unknown
    }

    if (
        typeof candidate.code !== 'string' || !candidate.code ||
        typeof candidate.message !== 'string' || !candidate.message ||
        !isErrorKind(candidate.kind)
    ) {
        return {
            code: 'WRITE_FAILED',
            message: '[Atoma] write op failed',
            kind: 'internal'
        }
    }

    const details = toErrorDetails(candidate.details)

    return {
        code: candidate.code,
        message: candidate.message,
        kind: candidate.kind,
        ...(details ? { details } : {}),
        ...(typeof candidate.retryable === 'boolean' ? { retryable: candidate.retryable } : {})
    }
}

export function parseQueryOpResult(results: unknown): QueryResultData {
    const parsed = assertRemoteOpResults(results)
    const result = parsed[0]
    if (!result) {
        throw new Error('[Atoma] queryViaOps: missing query result')
    }

    if (!result.ok) {
        throw new Error(result.error.message || '[Atoma] Query failed')
    }

    return assertQueryResultData(result.data)
}

export function parseWriteOpResults(args: {
    results: unknown
    entryGroups: ReadonlyArray<ReadonlyArray<WriteEntry>>
}): WriteItemResult[] {
    const parsed = assertRemoteOpResults(args.results)
    const results: WriteItemResult[] = []

    for (let index = 0; index < args.entryGroups.length; index++) {
        const entries = args.entryGroups[index]
        const opResult = parsed[index]

        if (!opResult) {
            throw new Error('[Atoma] persistViaOps: missing op result')
        }

        if (!opResult.ok) {
            const error = toStandardError(opResult.error)
            for (const entry of entries) {
                results.push({
                    entryId: entry.entryId,
                    ok: false,
                    error
                })
            }
            continue
        }

        const writeData = assertWriteResultData(opResult.data)
        results.push(...writeData.results)
    }

    return results
}
