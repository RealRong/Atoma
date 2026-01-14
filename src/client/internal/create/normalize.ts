import type { Table } from 'dexie'
import type {
    BackendEndpointConfig,
    HttpBackendConfig,
    SyncDefaultsArgs,
    SyncQueueWritesArgs,
    HttpEndpointOptions
} from '../../types'

export function makeIndexedDbTableForResource<T extends Record<string, Table<any, string>>>(
    tables: T
): (resource: string) => Table<any, string> {
    return (resource: string) => {
        const tbl = (tables as any)[resource]
        if (tbl) return tbl as Table<any, string>
        throw new Error(`[Atoma] indexedDB: 未知 resource: ${String(resource)}`)
    }
}

function pickHttpOverrides(args: HttpEndpointOptions | undefined): Partial<HttpBackendConfig> {
    if (!args) return {}
    return {
        ...(args.opsPath ? { opsPath: args.opsPath } : {}),
        ...(args.headers ? { headers: args.headers } : {}),
        ...(args.retry ? { retry: args.retry } : {}),
        ...(args.fetchFn ? { fetchFn: args.fetchFn } : {}),
        ...(args.onRequest ? { onRequest: args.onRequest } : {}),
        ...(args.onResponse ? { onResponse: args.onResponse } : {}),
        ...(args.responseParser ? { responseParser: args.responseParser } : {})
    }
}

export function mergeHttpOverrides(def: HttpEndpointOptions | undefined, lane: HttpEndpointOptions | undefined): Partial<HttpBackendConfig> {
    return {
        ...pickHttpOverrides(def),
        ...pickHttpOverrides(lane)
    }
}

function normalizeBaseUrlForCompare(url: string): string {
    const raw = String(url || '').trim()
    if (!raw) return ''
    try {
        const u = new URL(raw)
        const path = u.pathname.replace(/\/+$/g, '')
        return `${u.origin}${path}`
    } catch {
        return raw.replace(/\/+$/g, '')
    }
}

export function assertNoEchoEndpoint(args: { localServerUrl: string; syncUrl: string }) {
    const a = normalizeBaseUrlForCompare(args.localServerUrl)
    const b = normalizeBaseUrlForCompare(args.syncUrl)
    if (!a || !b) return
    if (a !== b) return

    throw new Error(
        '[Atoma] createClient: storage.type="localServer" 不能与 sync.url 指向同一个 endpoint（会导致 Replicator apply->persistToLocal 回写远端，引发无限循环 / version 自增）；请改用 indexeddb 作为本地存储，或让 localServer 指向 localhost、sync 指向云端'
    )
}

export function makeSyncEndpointFromBackend(args: {
    backend: BackendEndpointConfig
    httpOverrides: Partial<HttpBackendConfig>
    sse?: string
}): BackendEndpointConfig {
    const base = args.backend as any

    const wantsOv = Boolean(
        (args.sse && String(args.sse).trim())
        || (args.httpOverrides && Object.keys(args.httpOverrides).length)
    )

    if (!wantsOv) return args.backend

    const httpLike = typeof base === 'string'
        || (base && typeof base === 'object' && !Array.isArray(base) && 'http' in base)

    if (!httpLike) {
        throw new Error('[Atoma] createClient: 当 sync.backend 不是 http 时，不能再传入 opsPath/headers/retry/fetchFn/onRequest/onResponse/responseParser/sse')
    }

    const httpBase = typeof base === 'string' ? {} : (base.http ?? {})
    const baseURL = typeof base === 'string' ? String(base) : String(httpBase.baseURL || '')
    if (!baseURL) {
        throw new Error('[Atoma] createClient: sync.backend.http.baseURL is required')
    }

    return {
        http: {
            ...httpBase,
            baseURL,
            ...args.httpOverrides,
            ...(args.sse ? { subscribePath: args.sse } : {})
        }
    } as any
}

export function toSyncDefaults(args: {
    mode?: 'pull-only' | 'subscribe-only' | 'pull+subscribe' | 'push-only' | 'full'
    deviceId?: string
    advanced?: {
        outboxKey?: string
        cursorKey?: string
        lockKey?: string
        lockTtlMs?: number
        lockRenewIntervalMs?: number
    }
    resources?: string[]
    returning?: boolean
    subscribe?: boolean
    subscribeEventName?: string
    pullLimit?: number
    pullDebounceMs?: number
    pullIntervalMs?: number
    reconnectDelayMs?: number
    inFlightTimeoutMs?: number
    retry?: HttpBackendConfig['retry']
    backoff?: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number }
    now?: () => number
    conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    onEvent?: (event: unknown) => void
    onError?: (error: Error, context: unknown) => void
} | undefined): SyncDefaultsArgs | undefined {
    if (!args) return undefined
    return {
        ...(args.mode ? { mode: args.mode as any } : {}),
        ...(args.deviceId ? { deviceId: args.deviceId } : {}),
        ...(args.advanced ? { advanced: args.advanced } : {}),
        ...(args.resources ? { resources: args.resources } : {}),
        ...(typeof args.returning === 'boolean' ? { returning: args.returning } : {}),
        ...(typeof args.subscribe === 'boolean' ? { subscribe: args.subscribe } : {}),
        ...(args.subscribeEventName ? { subscribeEventName: args.subscribeEventName } : {}),
        ...(typeof args.pullLimit === 'number' ? { pullLimit: args.pullLimit } : {}),
        ...(typeof args.pullDebounceMs === 'number' ? { pullDebounceMs: args.pullDebounceMs } : {}),
        ...(typeof args.pullIntervalMs === 'number' ? { pullIntervalMs: args.pullIntervalMs } : {}),
        ...(typeof args.reconnectDelayMs === 'number' ? { reconnectDelayMs: args.reconnectDelayMs } : {}),
        ...(typeof args.inFlightTimeoutMs === 'number' ? { inFlightTimeoutMs: args.inFlightTimeoutMs } : {}),
        ...(args.retry ? { retry: args.retry as any } : {}),
        ...(args.backoff ? { backoff: args.backoff } : {}),
        ...(args.now ? { now: args.now } : {}),
        ...(args.conflictStrategy ? { conflictStrategy: args.conflictStrategy } : {}),
        ...(args.onEvent ? { onEvent: args.onEvent } : {}),
        ...(args.onError ? { onError: args.onError } : {})
    }
}

export function toSyncQueueWrites(args: {
    maxQueueSize?: number
    onQueueChange?: (size: number) => void
    onQueueFull?: (args: { maxQueueSize: number; droppedOp: unknown }) => void
} | undefined): SyncQueueWritesArgs | undefined {
    if (!args) return undefined
    return {
        ...(typeof args.maxQueueSize === 'number' ? { maxQueueSize: args.maxQueueSize } : {}),
        ...(args.onQueueChange ? { onQueueChange: args.onQueueChange } : {}),
        ...(args.onQueueFull ? { onQueueFull: args.onQueueFull as any } : {})
    }
}
