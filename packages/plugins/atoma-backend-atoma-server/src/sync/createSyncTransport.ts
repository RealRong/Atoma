import type { SyncTransport, SyncStream } from 'atoma-types/client/sync'
import { isRecord } from 'atoma-shared'
import {
    SSE_EVENT_NOTIFY,
    HTTP_PATH_SYNC_RXDB_PULL,
    HTTP_PATH_SYNC_RXDB_PUSH,
    HTTP_PATH_SYNC_RXDB_STREAM
} from 'atoma-types/protocol-tools'
import type {
    Envelope,
    RemoteOpsResponseData
} from 'atoma-types/protocol'
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
    options: Pick<
        AtomaServerBackendPluginOptions,
        'baseURL' | 'fetchFn' | 'headers' | 'retry' | 'onRequest' | 'onResponse' | 'syncPaths'
    >
): SyncTransport {
    const baseURL = options.baseURL
    const fetchFn = resolveFetch(options.fetchFn)
    const syncPaths = {
        pull: normalizeSyncPath(options.syncPaths?.pull, HTTP_PATH_SYNC_RXDB_PULL),
        push: normalizeSyncPath(options.syncPaths?.push, HTTP_PATH_SYNC_RXDB_PUSH),
        stream: normalizeSyncPath(options.syncPaths?.stream, HTTP_PATH_SYNC_RXDB_STREAM)
    }

    return {
        pull: async (request) => {
            return await postJson({
                path: syncPaths.pull,
                request,
                baseURL,
                fetchFn,
                headers: options.headers,
                retry: options.retry,
                onRequest: options.onRequest,
                onResponse: options.onResponse,
                parser: parsePullResponse
            })
        },
        push: async (request) => {
            return await postJson({
                path: syncPaths.push,
                request,
                baseURL,
                fetchFn,
                headers: options.headers,
                retry: options.retry,
                onRequest: options.onRequest,
                onResponse: options.onResponse,
                parser: parsePushResponse
            })
        },
        subscribe: (args) => {
            return createStream({
                baseURL,
                streamPath: syncPaths.stream,
                resource: args.resource,
                reconnectDelayMs: args.reconnectDelayMs,
                pollIntervalMs: args.pollIntervalMs,
                onNotify: args.onNotify,
                onError: args.onError
            })
        }
    }
}

async function postJson<T>(args: {
    path: string
    request: unknown
    baseURL: string
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    headers?: AtomaServerBackendPluginOptions['headers']
    retry?: AtomaServerBackendPluginOptions['retry']
    onRequest?: AtomaServerBackendPluginOptions['onRequest']
    onResponse?: AtomaServerBackendPluginOptions['onResponse']
    parser: (payload: unknown) => T
}): Promise<T> {
    const headers = await resolveHeaders(args.headers)
    if (!hasHeader(headers, 'content-type')) {
        headers['content-type'] = 'application/json; charset=utf-8'
    }
    let request = new Request(joinUrl(args.baseURL, args.path), {
        method: 'POST',
        headers,
        body: JSON.stringify(args.request)
    })
    if (typeof args.onRequest === 'function') {
        const nextRequest = await args.onRequest(request)
        if (nextRequest instanceof Request) {
            request = nextRequest
        }
    }

    const response = await fetchWithRetry({
        fetchFn: args.fetchFn,
        request,
        retry: args.retry
    })
    const payload = await readJson(response)

    if (typeof args.onResponse === 'function') {
        args.onResponse({
            response,
            request,
            envelope: createSyncEnvelope({
                status: response.status,
                payload
            })
        })
    }

    if (!response.ok) {
        throw new Error(`[Sync] request failed: HTTP ${response.status}`)
    }

    return args.parser(payload)
}

function createStream(args: {
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
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let reconnectFailures = 0
    let fallbackToPolling = false

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

        try {
            eventSource.close()
        } catch {
            // ignore
        }

        notifyListener = null
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
        }, args.pollIntervalMs)
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
            fallbackToPolling = false
            reconnectFailures = 0
            clearPoll()

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

            source.addEventListener(SSE_EVENT_NOTIFY, notifyListener)
            source.onerror = (_event) => {
                if (stopped) return
                args.onError(new Error('[Sync] stream connection error'))
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

function joinUrl(base: string, path: string): string {
    if (!base) return path
    if (!path) return base

    const hasTrailing = base.endsWith('/')
    const hasLeading = path.startsWith('/')

    if (hasTrailing && hasLeading) return `${base}${path.slice(1)}`
    if (!hasTrailing && !hasLeading) return `${base}/${path}`
    return `${base}${path}`
}

function normalizeSyncPath(path: string | undefined, fallback: string): string {
    if (typeof path !== 'string') return fallback
    const normalized = path.trim()
    return normalized || fallback
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

function hasHeader(headers: Record<string, string>, name: string): boolean {
    const needle = name.toLowerCase()
    return Object.keys(headers).some((key) => key.toLowerCase() === needle)
}

function createSyncEnvelope(args: {
    status: number
    payload: unknown
}): Envelope<RemoteOpsResponseData> {
    if (args.status >= 200 && args.status < 300) {
        return {
            ok: true,
            data: { results: [] },
            meta: {
                v: 1
            }
        }
    }

    return {
        ok: false,
        error: {
            code: `SYNC_HTTP_${args.status}`,
            message: `[Sync] request failed: HTTP ${args.status}`,
            kind: 'internal',
            ...(isRecord(args.payload)
                ? {
                    details: args.payload
                }
                : {})
        },
        meta: {
            v: 1
        }
    }
}

function parsePullResponse(payload: unknown): SyncPullResponse {
    const input = asRecord(payload, '[Sync] pull response')
    if (!Array.isArray(input.documents)) {
        throw new Error('[Sync] pull response.documents must be an array')
    }
    const documents = input.documents.map((value, index) => {
        return parseSyncDocument(value, `[Sync] pull response.documents[${index}]`)
    })
    const checkpoint = parseCheckpoint(input.checkpoint, '[Sync] pull response.checkpoint')
    return {
        documents,
        checkpoint
    }
}

function parsePushResponse(payload: unknown): SyncPushResponse {
    const input = asRecord(payload, '[Sync] push response')
    if (!Array.isArray(input.conflicts)) {
        throw new Error('[Sync] push response.conflicts must be an array')
    }
    const conflicts = input.conflicts.map((value, index) => {
        return parseSyncDocument(value, `[Sync] push response.conflicts[${index}]`)
    })
    return {
        conflicts
    }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object`)
    }
    return value as Record<string, unknown>
}

function asNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string`)
    }
    return value.trim()
}

function asNonNegativeInt(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
        throw new Error(`${label} must be a non-negative integer`)
    }
    return value
}

function parseCheckpoint(value: unknown, label: string): SyncCheckpoint {
    const input = asRecord(value, label)
    return {
        cursor: asNonNegativeInt(input.cursor, `${label}.cursor`)
    }
}

function parseSyncDocument(value: unknown, label: string): SyncDocument {
    const input = asRecord(value, label)
    const id = asNonEmptyString(input.id, `${label}.id`)
    const version = asNonNegativeInt(input.version, `${label}.version`)
    const deleted = input._deleted
    if (deleted !== undefined && typeof deleted !== 'boolean') {
        throw new Error(`${label}._deleted must be boolean`)
    }
    return {
        ...input,
        id,
        version,
        ...(deleted === undefined ? {} : { _deleted: deleted })
    }
}

function parseStreamNotify(value: unknown): SyncStreamNotify {
    if (typeof value !== 'string' || !value.trim()) {
        return {}
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(value)
    } catch {
        throw new Error('[Sync] stream notify payload is not valid JSON')
    }
    if (!isRecord(parsed)) {
        throw new Error('[Sync] stream notify payload must be an object')
    }

    const resource = parsed.resource
    if (resource !== undefined && (typeof resource !== 'string' || !resource.trim())) {
        throw new Error('[Sync] stream notify resource must be a non-empty string')
    }
    const cursor = parsed.cursor === undefined
        ? undefined
        : asNonNegativeInt(parsed.cursor, '[Sync] stream notify cursor')

    return {
        ...(typeof resource === 'string' ? { resource: resource.trim() } : {}),
        ...(cursor !== undefined ? { cursor } : {})
    }
}

function resolveEventSourceCtor(): EventSourceCtor | undefined {
    const candidate = (globalThis as any)?.EventSource
    return typeof candidate === 'function'
        ? candidate as EventSourceCtor
        : undefined
}

function normalizePositiveInt(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
    return Math.floor(value)
}

function addJitter(base: number): number {
    const jitter = Math.random() * 0.3 * base
    return base + jitter
}

function calculateBackoffDelay(args: {
    backoff: 'exponential' | 'linear'
    initialDelayMs: number
    attempt: number
    jitter: boolean
}): number {
    const base = args.backoff === 'exponential'
        ? args.initialDelayMs * Math.pow(2, Math.max(0, args.attempt - 1))
        : args.initialDelayMs * Math.max(1, args.attempt)
    return args.jitter ? addJitter(base) : base
}

function isAbortError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError')
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

async function fetchWithRetry(args: {
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    request: Request
    retry: AtomaServerBackendPluginOptions['retry']
}): Promise<Response> {
    const maxAttempts = normalizePositiveInt(args.retry?.maxAttempts, 3)
    const maxElapsedMs = normalizePositiveInt(args.retry?.maxElapsedMs, 30_000)
    const initialDelayMs = normalizePositiveInt(args.retry?.initialDelayMs, 1000)
    const backoff = args.retry?.backoff ?? 'exponential'
    const jitter = args.retry?.jitter === true
    const startedAt = Date.now()
    let attempt = 0
    let lastError: unknown

    while (attempt < maxAttempts) {
        attempt += 1
        try {
            if (args.request.signal?.aborted) {
                throw new Error('Request aborted')
            }

            const response = await args.fetchFn(args.request)
            if (response.status >= 500) {
                throw new Error(`[Sync] request failed: HTTP ${response.status}`)
            }
            return response
        } catch (error) {
            lastError = error
            if (args.request.signal?.aborted || isAbortError(error)) {
                throw error
            }
            if (attempt >= maxAttempts) {
                break
            }

            const delay = calculateBackoffDelay({
                backoff,
                initialDelayMs,
                attempt,
                jitter
            })
            if (Date.now() - startedAt + delay > maxElapsedMs) {
                break
            }
            await sleep(delay)
        }
    }

    if (lastError instanceof Error) {
        throw lastError
    }
    throw new Error('[Sync] request failed')
}

function resolveReconnectDelay(baseDelayMs: number, failures: number): number {
    const base = Math.max(200, Math.floor(baseDelayMs))
    return Math.min(base * Math.pow(2, Math.max(0, failures - 1)), 30_000)
}
