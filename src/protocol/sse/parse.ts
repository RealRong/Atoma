import type { ChangeBatch } from '../changes'
import type { Cursor } from '../scalars'

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isCursor(value: unknown): value is Cursor {
    return typeof value === 'string' && value.length > 0
}

export function parseChangeBatchJson(value: unknown): ChangeBatch {
    if (!isRecord(value)) {
        throw new Error('[Protocol.sse] Invalid ChangeBatch: expected object')
    }
    const nextCursor = value.nextCursor
    const changes = value.changes
    if (!isCursor(nextCursor)) {
        throw new Error('[Protocol.sse] Invalid ChangeBatch: missing nextCursor')
    }
    if (!Array.isArray(changes)) {
        throw new Error('[Protocol.sse] Invalid ChangeBatch: missing changes[]')
    }
    return value as ChangeBatch
}

export function parseChangeBatch(data: string): ChangeBatch {
    const json = JSON.parse(String(data))
    return parseChangeBatchJson(json)
}

