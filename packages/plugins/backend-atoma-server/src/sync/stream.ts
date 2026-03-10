import { joinUrl, normalizePositiveInt, toError } from '@atoma-js/shared'
import { parseSyncStreamNotify, SSE_EVENT_NOTIFY } from '@atoma-js/types/tools'
import type { SyncStream } from '@atoma-js/types/client/sync'
import type { SyncStreamNotify } from '@atoma-js/types/sync'

type EventSourceLike = {
    addEventListener: (name: string, listener: (event: { data?: unknown }) => void) => void
    removeEventListener?: (name: string, listener: (event: { data?: unknown }) => void) => void
    close: () => void
    onerror: ((event: unknown) => void) | null
}

type EventSourceCtor = new (url: string) => EventSourceLike

export function createStream(args: {
    baseURL: string
    streamPath: string
    resource: string
    reconnectDelayMs: number
    pollIntervalMs: number
    onNotify: (notify: SyncStreamNotify) => void
    onError: (error: unknown) => void
}): SyncStream {
    let stopped = true
    let eventSource: EventSourceLike | null = null
    let notifyListener: ((event: { data?: unknown }) => void) | null = null
    let openListener: ((event: { data?: unknown }) => void) | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let reconnectFailures = 0
    let fallbackToPolling = false
    const pollIntervalMs = Math.max(200, normalizePositiveInt(args.pollIntervalMs, 5_000))

    const clearReconnect = () => {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = null
        }
    }

    const clearPoll = () => {
        if (pollTimer) {
            clearInterval(pollTimer)
            pollTimer = null
        }
    }

    const closeEventSource = () => {
        if (!eventSource) return

        if (notifyListener && typeof eventSource.removeEventListener === 'function') {
            try {
                eventSource.removeEventListener(SSE_EVENT_NOTIFY, notifyListener)
            } catch {
                // ignore
            }
        }
        if (openListener && typeof eventSource.removeEventListener === 'function') {
            try {
                eventSource.removeEventListener('open', openListener)
            } catch {
                // ignore
            }
        }

        try {
            eventSource.close()
        } catch {
            // ignore
        }

        notifyListener = null
        openListener = null
        eventSource = null
    }

    const scheduleReconnect = () => {
        if (stopped || reconnectTimer || fallbackToPolling) return
        reconnectFailures += 1
        if (reconnectFailures >= 5) {
            fallbackToPolling = true
            startPolling()
            return
        }
        const delay = resolveReconnectDelay(args.reconnectDelayMs, reconnectFailures)

        reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            connect()
        }, delay)
    }

    const startPolling = () => {
        if (stopped || pollTimer) return

        pollTimer = setInterval(() => {
            args.onNotify({
                resource: args.resource
            })
        }, pollIntervalMs)
    }

    const connect = () => {
        if (stopped || eventSource) return

        const EventSourceImpl = resolveEventSourceCtor()
        if (!EventSourceImpl) {
            startPolling()
            return
        }

        const url = new URL(joinUrl(args.baseURL, args.streamPath))
        url.searchParams.set('resource', args.resource)

        try {
            const source = new EventSourceImpl(url.toString())
            eventSource = source
            clearPoll()

            openListener = () => {
                reconnectFailures = 0
                fallbackToPolling = false
                clearPoll()
            }
            source.addEventListener('open', openListener)

            notifyListener = (event) => {
                try {
                    const notify = parseSyncStreamNotify(event.data)
                    args.onNotify({
                        resource: notify.resource ?? args.resource,
                        ...(notify.cursor !== undefined ? { cursor: notify.cursor } : {})
                    })
                } catch (error) {
                    args.onError(toError(error))
                }
            }

            source.addEventListener(SSE_EVENT_NOTIFY, notifyListener)
            source.onerror = (_event) => {
                if (stopped) return
                args.onError(new Error('[Sync] stream connection error'))
                closeEventSource()
                scheduleReconnect()
            }
        } catch (error) {
            args.onError(toError(error))
            closeEventSource()
            scheduleReconnect()
        }
    }

    return {
        start: () => {
            if (!stopped) return
            stopped = false
            fallbackToPolling = false
            reconnectFailures = 0
            clearPoll()
            clearReconnect()
            connect()
        },
        stop: () => {
            if (stopped) return
            stopped = true
            clearReconnect()
            clearPoll()
            closeEventSource()
        },
        dispose: () => {
            stopped = true
            clearReconnect()
            clearPoll()
            closeEventSource()
        }
    }
}

function resolveEventSourceCtor(): EventSourceCtor | undefined {
    const candidate = (globalThis as any)?.EventSource
    return typeof candidate === 'function'
        ? candidate as EventSourceCtor
        : undefined
}

function resolveReconnectDelay(baseDelayMs: number, failures: number): number {
    const base = Math.max(200, normalizePositiveInt(baseDelayMs, 200))
    return Math.min(base * Math.pow(2, Math.max(0, failures - 1)), 30_000)
}
