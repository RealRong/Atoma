import pLimit from 'p-limit'
import { normalizeFindManyResponse, buildQueryParams } from './query'
import { sendJson, makeUrl, resolveEndpoint } from './request'
import type { HTTPAdapterConfig, StandardEnvelope } from '../HTTPAdapter'
import { BulkOperationHandler } from './bulkOperations'
import { ETagManager } from './etagManager'
import type { HTTPClient } from './client'
import type { SyncOrchestrator } from './syncOrchestrator'
import type { StoreKey, FindManyOptions, PageInfo, Entity } from '../../core/types'
import type { RequestIdSequencer } from '../../observability/trace'
import { deriveRequestId } from '../../observability/trace'
import { getDebugCarrier } from '../../observability/internal'
import { utf8ByteLength } from '../../observability/utf8'

export interface OperationExecutors<T extends Entity> {
    put: (key: StoreKey, value: T) => Promise<void>
    bulkPut: (items: T[]) => Promise<void>
    delete: (key: StoreKey) => Promise<void>
    bulkDelete: (keys: StoreKey[]) => Promise<void>
    get: (key: StoreKey) => Promise<T | undefined>
    bulkGet: (keys: StoreKey[]) => Promise<(T | undefined)[]>
    getAll: (filter?: (item: T) => boolean) => Promise<T[]>
    findMany: (options?: FindManyOptions<T>) => Promise<{ data: T[]; pageInfo?: PageInfo }>
}

type Deps<T extends Entity> = {
    config: HTTPAdapterConfig<T>
    client: HTTPClient<T>
    bulkOps: BulkOperationHandler<T>
    etagManager: ETagManager
    fetchWithRetry: (input: RequestInfo, init?: RequestInit) => Promise<Response>
    getHeaders: () => Promise<Record<string, string>>
    requestIdSequencer?: RequestIdSequencer
    orchestrator: SyncOrchestrator<T>
    onError: (error: Error, operation: string) => void
}

export function createOperationExecutors<T extends Entity>(deps: Deps<T>): OperationExecutors<T> {
    const {
        config,
        client,
        bulkOps,
        etagManager,
        fetchWithRetry,
        getHeaders,
        orchestrator,
        onError
    } = deps
    const endpoints = config.endpoints!
    const requestSeqByTraceId = deps.requestIdSequencer ? undefined : new Map<string, number>()

    const traceHeadersFor = (options?: FindManyOptions<T>) => {
        const traceId = typeof (options as any)?.debug?.traceId === 'string' ? (options as any).debug.traceId as string : undefined
        if (!traceId) return undefined
        const requestId = deps.requestIdSequencer
            ? deps.requestIdSequencer.next(traceId)
            : (() => {
                const cur = requestSeqByTraceId!.get(traceId) ?? 0
                const next = cur + 1
                requestSeqByTraceId!.set(traceId, next)
                return deriveRequestId(traceId, next)
            })()
        return {
            traceId,
            requestId,
            headers: {
                'x-atoma-trace-id': traceId,
                'x-atoma-request-id': requestId
            }
        }
    }

    /**
     * Helper to parse response using the user-provided parser or default identity behavior
     */
    const parseResponse = async (response: Response, json: any, request: Request): Promise<StandardEnvelope<T>> => {
        let envelope: StandardEnvelope<T>

        if (config.responseParser) {
            envelope = await config.responseParser(response, json)
        } else {
            // 默认：若形如 { data, pageInfo } 则直接视为标准信封，否则把 json 当作 data
            if (json && typeof json === 'object' && 'data' in json) {
                envelope = json as StandardEnvelope<T>
            } else {
                envelope = { data: json }
            }
        }

        // Trigger global response interceptor
        if (config.onResponse) {
            config.onResponse({
                response,
                envelope,
                request
            })
        }

        // Handle error flag
        if (envelope.isError) {
            throw new Error(envelope.message || `Error ${envelope.code || 'unknown'}`)
        }

        return envelope
    }

    /**
     * Central request execution helper with onRequest interception
     */
    const executeRequest = async (request: Request): Promise<{ envelope: StandardEnvelope<T>, response: Response }> => {
        let req = request

        // 1. Trigger onRequest interceptor
        if (config.onRequest) {
            const result = await config.onRequest(req)
            if (result instanceof Request) {
                req = result
            }
            // If result is void/undefined, keep using original req
            // If it threw error, it bubbles up naturally to cancel request
        }

        // 2. Perform Network Request
        // fetchWithRetry expects (input: RequestInfo, init?: RequestInit)
        // We can pass `req` as input.
        const response = await fetchWithRetry(req)

        // 3. Parse Response & Trigger onResponse (handled inside parseResponse)
        // We pass the potentially modified `req` for context
        // Ensure to clone response/json as needed in parseResponse, 
        // but here we just need to extract JSON first as parseResponse expects (response, json, req).
        // Wait, parseResponse consumes JSON? 
        // Ideally we should move json extraction into parseResponse or do it here.
        // Existing logic did: const json = await response.json(); parseResponse(...)

        let json: any
        try {
            // Check for 204 No Content or empty body to avoid JSON parse error
            if (response.status === 204) {
                json = null
            } else {
                json = await response.json()
            }
        } catch (e) {
            // Fallback for non-JSON responses?
            json = null
        }

        const envelope = await parseResponse(response, json, req)
        return { envelope, response }
    }

    const put = async (key: StoreKey, value: T) => {
        await orchestrator.handleWithOfflineFallback({ type: 'put', key, value }, () => client.put(key, value))
    }

    const del = async (key: StoreKey) => {
        await orchestrator.handleWithOfflineFallback({ type: 'delete', key }, () => client.delete(key))
    }

    const bulkPut = async (items: T[]) => {
        if (config.endpoints!.bulkUpdate) {
            await client.bulkUpdate(items)
            return
        }
        await bulkOps.runFallbackPut(items)
    }

    const bulkDelete = async (keys: StoreKey[]) => {
        if (config.endpoints!.bulkDelete) {
            await client.bulkDelete(keys)
            return
        }

        const qp = config.endpoints!.bulkDeleteQueryParam
        if (qp) {
            const url = `${config.baseURL}${resolveEndpoint(qp.path)}?${qp.param}=${keys.join(',')}`
            const maxLen = qp.maxUrlLength ?? 1800
            if (url.length <= maxLen) {
                const headers = await getHeaders()
                const response = await fetchWithRetry(url, { method: 'DELETE', headers })
                if (response.ok) {
                    keys.forEach(k => etagManager.delete(k))
                    return
                }
            }
        }

        await bulkOps.runFallbackDelete(keys)
    }

    const get = async (key: StoreKey): Promise<T | undefined> => {
        try {
            const url = makeUrl(config.baseURL, resolveEndpoint(endpoints.getOne!, key))
            const headers = await getHeaders()

            // Build Request
            const request = new Request(url, { method: 'GET', headers })

            // Execute with Interceptors
            // Execute with Interceptors
            const { envelope, response } = await executeRequest(request)

            const etag = etagManager.extractFromResponse(response)
            if (etag) etagManager.set(key, etag)

            return envelope.data as T

        } catch (error) {
            onError(error as Error, `get(${key})`)
            return undefined
        }
    }

    const bulkGet = async (keys: StoreKey[]) => {
        const concurrency = config.concurrency?.bulk ?? config.concurrency?.get ?? 5
        const limit = pLimit(concurrency)
        return Promise.all(keys.map(key => limit(() => get(key))))
    }

    const getAll = async (filter?: (item: T) => boolean) => {
        try {
            const url = makeUrl(config.baseURL, resolveEndpoint(endpoints.getAll!))
            const headers = await getHeaders()

            const request = new Request(url, { method: 'GET', headers })
            const { envelope } = await executeRequest(request)

            const items: T[] = Array.isArray(envelope.data) ? envelope.data : []
            return filter ? items.filter(filter) : items
        } catch (error) {
            onError(error as Error, 'getAll')
            return []
        }
    }

    const dispatchSerializedQuery = async (payload: URLSearchParams | object) => {
        const headers = await getHeaders()
        // URLSearchParams → GET
        if (payload instanceof URLSearchParams) {
            const url = `${config.baseURL}${resolveEndpoint(endpoints.getAll!)}?${payload.toString()}`

            const request = new Request(url, { method: 'GET', headers })
            const { envelope } = await executeRequest(request)

            // If data is array, we might want to attach pageInfo if present in the envelope
            if (Array.isArray(envelope.data)) {
                return {
                    data: envelope.data,
                    pageInfo: envelope.pageInfo as PageInfo
                }
            }
            // If it's single item, wrap it
            return {
                data: [envelope.data as T],
                pageInfo: envelope.pageInfo as PageInfo
            }
        }
        // object → POST JSON
        const url = `${config.baseURL}${resolveEndpoint(endpoints.getAll!)}`

        const request = new Request(url, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        const { envelope } = await executeRequest(request)

        if (Array.isArray(envelope.data)) {
            return {
                data: envelope.data,
                pageInfo: envelope.pageInfo as PageInfo
            }
        }
        return {
            data: [envelope.data as T],
            pageInfo: envelope.pageInfo as PageInfo
        }
    }

    const findMany = async (options?: FindManyOptions<T>) => {
        if (config.query?.customFn) {
            return config.query.customFn(options || {} as any)
        }

        if (config.query?.serializer) {
            const payload = config.query.serializer(options || {} as any)
            return dispatchSerializedQuery(payload)
        }

        const strategy = config.query?.strategy || 'REST'
        if (strategy === 'REST' || strategy === 'Django') {
            const params = buildQueryParams(options, config.querySerializer)
            const url = `${config.baseURL}${resolveEndpoint(endpoints.getAll!)}?${params.toString()}`
            const headers = await getHeaders()
            const trace = traceHeadersFor(options)
            const emitter = getDebugCarrier(options)?.emitter

            const request = new Request(url, { method: 'GET', headers: { ...headers, ...(trace?.headers || {}) } })
            const startedAt = Date.now()
            try {
                emitter?.emit('adapter:request', {
                    method: 'GET',
                    endpoint: resolveEndpoint(endpoints.getAll!),
                    attempt: 1,
                    payloadBytes: 0
                }, { requestId: trace?.requestId })

                const { envelope, response } = await executeRequest(request)
                emitter?.emit('adapter:response', {
                    ok: response.ok,
                    status: response.status,
                    durationMs: Date.now() - startedAt,
                    itemCount: Array.isArray(envelope.data) ? envelope.data.length : (envelope.data ? 1 : 0)
                }, { requestId: trace?.requestId })

                if (Array.isArray(envelope.data)) {
                    return {
                        data: envelope.data,
                        pageInfo: envelope.pageInfo as PageInfo
                    }
                }
                return {
                    data: [envelope.data as T],
                    pageInfo: envelope.pageInfo as PageInfo
                }
            } catch (error: any) {
                emitter?.emit('adapter:response', {
                    ok: false,
                    status: typeof error?.status === 'number' ? error.status : undefined,
                    durationMs: undefined
                }, { requestId: trace?.requestId })
                throw error
            }
        }

        const url = `${config.baseURL}${resolveEndpoint(endpoints.getAll!)}`
        const headers = await getHeaders()
        const trace = traceHeadersFor(options)
        const emitter = getDebugCarrier(options)?.emitter

        const request = new Request(url, {
            method: 'POST',
            headers: { ...headers, ...(trace?.headers || {}), 'Content-Type': 'application/json' },
            body: JSON.stringify(options || {})
        })
        const startedAt = Date.now()
        try {
            emitter?.emit('adapter:request', {
                method: 'POST',
                endpoint: resolveEndpoint(endpoints.getAll!),
                attempt: 1,
                payloadBytes: utf8ByteLength(JSON.stringify(options || {}))
            }, { requestId: trace?.requestId })

            const { envelope, response } = await executeRequest(request)
            emitter?.emit('adapter:response', {
                ok: response.ok,
                status: response.status,
                durationMs: Date.now() - startedAt,
                itemCount: Array.isArray(envelope.data) ? envelope.data.length : (envelope.data ? 1 : 0)
            }, { requestId: trace?.requestId })

            if (Array.isArray(envelope.data)) {
                return {
                    data: envelope.data,
                    pageInfo: envelope.pageInfo as PageInfo
                }
            }
            return {
                data: [envelope.data as T],
                pageInfo: envelope.pageInfo as PageInfo
            }
        } catch (error: any) {
            emitter?.emit('adapter:response', {
                ok: false,
                status: typeof error?.status === 'number' ? error.status : undefined,
                durationMs: undefined
            }, { requestId: trace?.requestId })
            throw error
        }
    }

    return { put, bulkPut, delete: del, bulkDelete, get, bulkGet, getAll, findMany }
}
