import { createCodedError, isCodedError } from 'atoma-shared'
import type { ExecutionError, ExecutionErrorCode } from 'atoma-types/runtime'

export type CreateExecutionError = (input: {
    code: ExecutionErrorCode
    message: string
    retryable?: boolean
    details?: Readonly<Record<string, unknown>>
    cause?: unknown
}) => ExecutionError

export function createExecutionError({
    code,
    message,
    retryable,
    details,
    cause
}: {
    code: ExecutionErrorCode
    message: string
    retryable?: boolean
    details?: Readonly<Record<string, unknown>>
    cause?: unknown
}): ExecutionError {
    return createCodedError({
        code,
        message,
        retryable,
        details,
        cause
    }) as ExecutionError
}

export function normalizeExecutionError({
    error,
    fallbackCode,
    fallbackMessage,
    retryable,
    details,
    createError
}: {
    error: unknown
    fallbackCode: ExecutionErrorCode
    fallbackMessage: string
    retryable?: boolean
    details?: Readonly<Record<string, unknown>>
    createError: CreateExecutionError
}): ExecutionError {
    return isCodedError(error)
        ? error as ExecutionError
        : createError({
            code: fallbackCode,
            message: fallbackMessage,
            retryable,
            details,
            cause: error
        })
}
