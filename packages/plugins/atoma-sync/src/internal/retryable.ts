export class RetryableSyncError extends Error {
    readonly cause: unknown

    constructor(cause: unknown, message?: string) {
        super(message ?? '[Sync] retryable error')
        this.name = 'RetryableSyncError'
        this.cause = cause
    }
}

export function isRetryableSyncError(error: unknown): error is RetryableSyncError {
    return error instanceof RetryableSyncError
}

