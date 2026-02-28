import type { StandardError } from 'atoma-types/protocol'
import type { SyncPullRequest, SyncPushRequest } from 'atoma-types/sync'
import {
    parseSyncPullRequest,
    parseSyncPushRequest,
    wrapProtocolError
} from 'atoma-types/protocol-tools'
import { throwError } from '../error'

function toThrowDetails(details: unknown): Record<string, unknown> | undefined {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
    return details as Record<string, unknown>
}

export function toThrowErrorDetails(error: { details?: unknown; kind: string }): Record<string, unknown> | undefined {
    const details = error.details
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
    const { kind: _kind, ...rest } = details as Record<string, unknown>
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
    const details = toThrowDetails(standard.details)
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

export function throwFromStandardError(error: StandardError): never {
    const details = toThrowErrorDetails(error)
    throwError(error.code, error.message, {
        kind: error.kind,
        ...(details ? details : {})
    } as any)
}
