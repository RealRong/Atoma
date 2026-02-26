import type { SyncTransport, SyncStream } from 'atoma-types/client/sync'
import { isRecord } from 'atoma-shared'
import {
    HTTP_PATH_SYNC_RXDB_PULL,
    HTTP_PATH_SYNC_RXDB_PUSH,
    HTTP_PATH_SYNC_RXDB_STREAM
} from 'atoma-types/protocol-tools'
import type {
    SyncCheckpoint,
    SyncDocument,
    SyncPullResponse,
    SyncPushResponse,
    SyncStreamNotify
} from 'atoma-types/sync'
import type { AtomaServerBackendPluginOptions } from '../types'

type EventSourceLike = {
    addEventListener: (name: string, listener: (event: { data?: unknown }) => void) => void
    removeEventListener?: (name: string, listener: (event: { data?: unknown }) => void) => void
    close: () => void
    onerror: ((event: unknown) => void) | null
}

type EventSourceCtor = new (url: string) => EventSourceLike

export function createSyncTransport(
    options: Pick<AtomaServerBackendPluginOptions, 'baseURL' | 'fetchFn' | 'headers'>
): SyncTransport {
    const baseURL = normalizeBaseURL(options.baseURL)
    const fetchFn = resolveFetch(options.fetchFn)

    return {
        pull: async (request) => {
            const payload = await postJson({
                path: HTTP_PATH_SYNC_RXDB_PULL,
                request,
                baseURL,
                fetchFn,
                headers: options.headers
            })

            if (!isRecord(payload)) {
                throw new Error('[Sync] pull response must be an object')
            }

            const documents = Array.isArray(payload.documents)
                ? payload.documents as SyncDocument[]
                : []
            const checkpoint = resolveCheckpoint(payload.checkpoint)
            return {
                documents,
                checkpoint
            } satisfies SyncPullResponse
        },
        push: async (request) => {
            const payload = await postJson({
                path: HTTP_PATH_SYNC_RXDB_PUSH,
                request,
                baseURL,
                fetchFn,
                headers: options.headers
            })

            if (!isRecord(payload)) {
                throw new Error('[Sync] push response must be an object')
            }

            const conflicts = Array.isArray(payload.conflicts)
                ? payload.conflicts as SyncDocument[]
                : []
            return {
                conflicts
            } satisfies SyncPushResponse
        },
        subscribe: (args) => {
            return createStream({
                baseURL,
                resource: args.resource,
                reconnectDelayMs: args.reconnectDelayMs,
                pollIntervalMs: args.pollIntervalMs,
                onNotify: args.onNotify,
                onError: args.onError
            })
        }
    }
}

async function postJson(args: {
    path: string
    request: unknown
    baseURL: string
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    headers?: AtomaServerBackendPluginOptions['headers']
}): Promise<unknown> {
    const response = await args.fetchFn(
        new URL(args.path, args.baseURL).toString(),
        {
            method: 'POST',
            headers: {
                'content-type': 'application/json; charset=utf-8',
                ...(await resolveHeaders(args.headers))
            },
            body: JSON.stringify(args.request)
        }
    )

    if (!response.ok) {
        throw new Error(`[Sync] request failed: HTTP ${response.status}`)
    }

    return await readJson(response)
}

function createStream(args: {
    baseURL: string
    resource: string
    reconnectDelayMs: number
    pollIntervalMs: number
    onNotify: (notify: SyncStreamNotify) => void
    onError: (error: unknown) => void
}): SyncStream {
    let stopped = true
    let eventSource: EventSourceLike | null = null
    let notifyListener: ((event: { data?: unknown }) => void) | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null

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
                eventSource.removeEventListener('sync.notify', notifyListener)
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
        eventSource = null
    }

    const scheduleReconnect = () => {
        if (stopped || reconnectTimer) return

        reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            connect()
        }, args.reconnectDelayMs)
    }

    const startPolling = () => {
        if (stopped || pollTimer) return

        pollTimer = setInterval(() => {
            args.onNotify({
                resource: args.resource
            })
        }, args.pollIntervalMs)
    }

    const connect = () => {
        if (stopped || eventSource) return

        const EventSourceImpl = resolveEventSourceCtor()
        if (!EventSourceImpl) {
            startPolling()
            return
        }

        const url = new URL(HTTP_PATH_SYNC_RXDB_STREAM, args.baseURL)
        url.searchParams.set('resource', args.resource)

        try {
            const source = new EventSourceImpl(url.toString())
            eventSource = source

            notifyListener = (event) => {
                try {
                    const notify = parseStreamNotify(event.data)
                    args.onNotify({
                        resource: notify.resource ?? args.resource,
                        ...(notify.cursor !== undefined ? { cursor: notify.cursor } : {})
                    })
                } catch (error) {
                    args.onError(error)
                }
            }

            source.addEventListener('sync.notify', notifyListener)
            source.onerror = () => {
                if (stopped) return
                closeEventSource()
                scheduleReconnect()
            }
        } catch (error) {
            args.onError(error)
            closeEventSource()
            scheduleReconnect()
        }
    }

    return {
        start: () => {
            if (!stopped) return
            stopped = false
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

function normalizeBaseURL(value: string): string {
    const normalized = String(value ?? '').trim()
    if (!normalized) {
        throw new Error('[Sync] baseURL is required')
    }
    return normalized.endsWith('/')
        ? normalized
        : `${normalized}/`
}

function resolveFetch(
    fetchFn: AtomaServerBackendPluginOptions['fetchFn']
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    if (typeof fetchFn === 'function') {
        return async (input, init) => {
            return await fetchFn(input, init)
        }
    }

    if (typeof globalThis.fetch === 'function') {
        return async (input, init) => {
            return await globalThis.fetch(input, init)
        }
    }

    throw new Error('[Sync] fetch is not available')
}

async function resolveHeaders(
    provider: AtomaServerBackendPluginOptions['headers']
): Promise<Record<string, string>> {
    if (!provider) return {}

    const value = await provider()
    if (!isRecord(value)) return {}

    const headers: Record<string, string> = {}
    for (const [key, raw] of Object.entries(value)) {
        if (!key) continue
        if (raw === undefined || raw === null) continue
        headers[String(key)] = String(raw)
    }
    return headers
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!text.trim()) return {}

    try {
        return JSON.parse(text)
    } catch {
        throw new Error('[Sync] response body is not valid JSON')
    }
}

function resolveCheckpoint(value: unknown): SyncCheckpoint {
    if (!isRecord(value)) {
        return { cursor: 0 }
    }

    const cursor = readCursor(value.cursor)
    return {
        cursor: cursor ?? 0
    }
}

function parseStreamNotify(value: unknown): SyncStreamNotify {
    if (typeof value !== 'string' || !value.trim()) {
        return {}
    }

    const parsed = JSON.parse(value)
    if (!isRecord(parsed)) return {}

    const resource = typeof parsed.resource === 'string'
        ? parsed.resource
        : undefined
    const cursor = readCursor(parsed.cursor)

    return {
        ...(resource ? { resource } : {}),
        ...(cursor !== undefined ? { cursor } : {})
    }
}

function resolveEventSourceCtor(): EventSourceCtor | undefined {
    const candidate = (globalThis as any)?.EventSource
    return typeof candidate === 'function'
        ? candidate as EventSourceCtor
        : undefined
}

function readCursor(value: unknown): number | undefined {
    const cursor = Number(value)
    if (!Number.isFinite(cursor)) return undefined
    if (cursor < 0) return undefined
    return Math.floor(cursor)
}
