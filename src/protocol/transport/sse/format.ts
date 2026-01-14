import { SSE_EVENT_NOTIFY } from './constants'

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

export function sseNotify(msg: unknown) {
    return sseEvent(SSE_EVENT_NOTIFY, msg)
}
