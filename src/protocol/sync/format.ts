import { SYNC_SSE_EVENT_CHANGES } from './types'
import type { SyncSubscribeEvent } from './types'

export function sseComment(text: string) {
    return `:${String(text)}\n\n`
}

export function sseRetry(ms: number) {
    const n = Number(ms)
    const value = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
    return `retry: ${value}\n\n`
}

export function sseEvent(name: string, data: unknown) {
    const eventName = String(name)
    const json = JSON.stringify(data)
    return `event: ${eventName}\n` + `data: ${json}\n\n`
}

export function sseChanges(event: SyncSubscribeEvent) {
    return sseEvent(SYNC_SSE_EVENT_CHANGES, event)
}
