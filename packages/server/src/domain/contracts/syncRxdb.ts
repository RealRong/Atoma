import type { StandardError } from '@atoma-js/types/protocol'
import type { SyncPullRequest, SyncPushRequest } from '@atoma-js/types/sync'
import {
    parseSyncPullRequest,
    parseSyncPushRequest,
    parseSyncStreamQuery,
    wrapProtocolError
} from '@atoma-js/types/tools'
import { throwError } from '../../error'
import { toObjectDetails } from '../../shared/utils/details'

export function toThrowErrorDetails(error: { details?: unknown; kind: string }): Record<string, unknown> | undefined {
    const details = toObjectDetails(error.details)
    if (!details) return undefined
    const { kind: _kind, ...rest } = details
    return Object.keys(rest).length ? rest : undefined
}

function throwValidationFromProtocol(error: unknown, fallback: {
    code: string
    message: string
}): never {
    const standard = wrapProtocolError(error, {
        code: fallback.code,
        message: fallback.message,
        kind: 'validation'
    })
    const details = toObjectDetails(standard.details)
    return throwError(standard.code, standard.message, {
        kind: standard.kind,
        ...(details ? details : {})
    } as any)
}

export function parseSyncPullRequestOrThrow(
    input: unknown,
    args: { defaultBatchSize: number }
): SyncPullRequest {
    try {
        return parseSyncPullRequest(input, args)
    } catch (error) {
        throwValidationFromProtocol(error, {
            code: 'INVALID_REQUEST',
            message: 'Invalid sync pull request'
        })
    }
}

export function parseSyncPushRequestOrThrow(input: unknown): SyncPushRequest {
    try {
        return parseSyncPushRequest(input)
    } catch (error) {
        throwValidationFromProtocol(error, {
            code: 'INVALID_REQUEST',
            message: 'Invalid sync push request'
        })
    }
}

export function parseSyncStreamQueryFromUrl(urlObj: URL) {
    try {
        return parseSyncStreamQuery(urlObj)
    } catch (error) {
        throwValidationFromProtocol(error, {
            code: 'INVALID_REQUEST',
            message: 'Invalid sync stream query'
        })
    }
}

export function throwFromStandardError(error: StandardError): never {
    const details = toThrowErrorDetails(error)
    throwError(error.code, error.message, {
        kind: error.kind,
        ...(details ? details : {})
    } as any)
}
