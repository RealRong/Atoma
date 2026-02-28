import type { StandardError as StandardErrorType } from 'atoma-types/protocol'

export type WriteConflict = {
    currentVersion?: number
    currentValue?: unknown
}

export function extractConflictMeta(error: StandardErrorType | unknown): WriteConflict {
    const details = (error as any)?.details
    const currentValue = details && typeof details === 'object' ? (details as any).currentValue : undefined
    const currentVersion = details && typeof details === 'object' ? (details as any).currentVersion : undefined
    return {
        ...(currentValue !== undefined ? { currentValue } : {}),
        ...(typeof currentVersion === 'number' ? { currentVersion } : {})
    }
}
