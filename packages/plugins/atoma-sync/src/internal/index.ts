import type { CursorStore } from 'atoma-types/sync'
import type { Cursor } from 'atoma-types/protocol'

export { AbortError, isAbortError } from '#sync/internal/abort'
export { sleepMs } from '#sync/internal/sleep'
export { RetryableSyncError, isRetryableSyncError } from '#sync/internal/retryable'
export { resolveRetryBackoff, computeBackoffDelayMs } from '#sync/internal/backoff'

export function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
}

export async function readCursorOrInitial(args: {
    cursor: CursorStore
    initialCursor?: Cursor
}): Promise<Cursor> {
    const cur = await args.cursor.get()
    if (cur !== undefined && cur !== null && cur !== '') return cur
    return args.initialCursor ?? '0'
}