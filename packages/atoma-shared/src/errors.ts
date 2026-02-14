export function toError(reason: unknown): Error {
    if (reason instanceof Error) return reason
    if (typeof reason === 'string' && reason) return new Error(reason)
    try {
        return new Error(JSON.stringify(reason))
    } catch {
        return new Error('Unknown error')
    }
}

export function toErrorWithFallback(reason: unknown, fallbackMessage: string): Error {
    if (reason instanceof Error) return reason
    if (typeof reason === 'string' && reason) return new Error(reason)
    try {
        return new Error(`${fallbackMessage}: ${JSON.stringify(reason)}`)
    } catch {
        return new Error(fallbackMessage)
    }
}

export type CodedError<TCode extends string = string> = Error & {
    code: TCode
    retryable: boolean
    details?: Readonly<Record<string, unknown>>
    cause?: unknown
}

export function createCodedError<TCode extends string>(args: {
    code: TCode
    message: string
    retryable?: boolean
    details?: Readonly<Record<string, unknown>>
    cause?: unknown
}): CodedError<TCode> {
    const error = new Error(args.message) as CodedError<TCode>
    error.name = 'AtomaError'
    error.code = args.code
    error.retryable = args.retryable === true
    if (args.details !== undefined) {
        error.details = args.details
    }
    if (args.cause !== undefined) {
        error.cause = args.cause
    }
    return error
}

export function isCodedError<TCode extends string = string>(value: unknown): value is CodedError<TCode> {
    if (!value || typeof value !== 'object') return false
    const candidate = value as {
        code?: unknown
        retryable?: unknown
        message?: unknown
    }
    return typeof candidate.code === 'string'
        && typeof candidate.retryable === 'boolean'
        && typeof candidate.message === 'string'
}
