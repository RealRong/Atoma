export class AbortError extends Error {
    readonly cause: unknown

    constructor(message?: string, cause?: unknown) {
        super(message ?? 'aborted')
        this.name = 'AbortError'
        this.cause = cause
    }
}

export function isAbortError(error: unknown): error is AbortError {
    return error instanceof AbortError
}

