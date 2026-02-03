import type { NotifyMessage } from 'atoma-types/protocol'

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
    if (!Array.isArray(value)) return false
    return value.every(v => typeof v === 'string')
}

export function parseNotifyMessageJson(value: unknown): NotifyMessage {
    if (!isRecord(value)) {
        throw new Error('[Protocol.sse] Invalid NotifyMessage: expected object')
    }

    const resources = value.resources
    if (resources !== undefined && !isStringArray(resources)) {
        throw new Error('[Protocol.sse] Invalid NotifyMessage: resources must be string[]')
    }

    const traceId = value.traceId
    if (traceId !== undefined && typeof traceId !== 'string') {
        throw new Error('[Protocol.sse] Invalid NotifyMessage: traceId must be string')
    }

    return value as NotifyMessage
}

export function parseNotifyMessage(data: string): NotifyMessage {
    const json = JSON.parse(String(data))
    return parseNotifyMessageJson(json)
}
