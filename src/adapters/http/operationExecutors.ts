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
import type { InternalOperationContext } from '../../observability/types'
import { utf8ByteLength } from '../../observability/utf8'
import { TRACE_ID_HEADER, REQUEST_ID_HEADER } from '../../protocol/trace'

export interface OperationExecutors<T extends Entity> {
    put: (key: StoreKey, value: T, context?: InternalOperationContext) => Promise<void>
    bulkPut: (items: T[], context?: InternalOperationContext) => Promise<void>
    delete: (key: StoreKey, context?: InternalOperationContext) => Promise<void>
    bulkDelete: (keys: StoreKey[], context?: InternalOperationContext) => Promise<void>
    get: (key: StoreKey, context?: InternalOperationContext) => Promise<T | undefined>
    bulkGet: (keys: StoreKey[], context?: InternalOperationContext) => Promise<(T | undefined)[]>
    getAll: (filter?: (item: T) => boolean, context?: InternalOperationContext) => Promise<T[]>
    findMany: (options?: FindManyOptions<T>, context?: InternalOperationContext) => Promise<{ data: T[]; pageInfo?: PageInfo }>
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

    const traceHeadersFor = (context?: InternalOperationContext) => {
        const traceId = typeof context?.traceId === 'string' ? context.traceId : undefined
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
                [TRACE_ID_HEADER]: traceId,
                [REQUEST_ID_HEADER]: requestId
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

    const put = async (key: StoreKey, value: T, context?: InternalOperationContext) => {
        const trace = traceHeadersFor(context)
        await orchestrator.handleWithOfflineFallback(
            { type: 'put', key, value },
            () => client.put(
                key,
                value,
                trace?.headers,
                trace && context?.emitter ? { emitter: context.emitter, requestId: trace.requestId } : undefined
            )
        )
    }

    const del = async (key: StoreKey, context?: InternalOperationContext) => {
        const trace = traceHeadersFor(context)
        await orchestrator.handleWithOfflineFallback(
            { type: 'delete', key },
            () => client.delete(
                key,
                trace?.headers,
                trace && context?.emitter ? { emitter: context.emitter, requestId: trace.requestId } : undefined
            )
        )
    }

    const bulkPut = async (items: T[], context?: InternalOperationContext) => {
        if (config.endpoints!.bulkUpdate) {
            const trace = traceHeadersFor(context)
            await client.bulkUpdate(
                items,
                trace?.headers,
                trace && context?.emitter ? { emitter: context.emitter, requestId: trace.requestId } : undefined
            )
            return
        }
        await bulkOps.runFallbackPut(items, context)
    }

    const bulkDelete = async (keys: StoreKey[], context?: InternalOperationContext) => {
        if (config.endpoints!.bulkDelete) {
            const trace = traceHeadersFor(context)
            await client.bulkDelete(
                keys,
                trace?.headers,
                trace && context?.emitter ? { emitter: context.emitter, requestId: trace.requestId } : undefined
            )
            return
        }

        const qp = config.endpoints!.bulkDeleteQueryParam
        if (qp) {
            const url = `${config.baseURL}${resolveEndpoint(qp.path)}?${qp.param}=${keys.join(',')}`
            const maxLen = qp.maxUrlLength ?? 1800
            if (url.length <= maxLen) {
                const headers = await getHeaders()
                const trace = traceHeadersFor(context)
                const startedAt = context?.emitter ? Date.now() : 0
                context?.emitter?.emit('adapter:request', {
                    method: 'DELETE',
                    endpoint: resolveEndpoint(qp.path),
                    attempt: 1,
                    payloadBytes: 0
                }, { requestId: trace?.requestId })

                const response = await fetchWithRetry(url, { method: 'DELETE', headers: { ...headers, ...(trace?.headers || {}) } })

                context?.emitter?.emit('adapter:response', {
                    ok: response.ok,
                    status: response.status,
                    durationMs: context?.emitter ? (Date.now() - startedAt) : undefined
                }, { requestId: trace?.requestId })
                if (response.ok) {
                    keys.forEach(k => etagManager.delete(k))
                    return
                }
            }
        }

        await bulkOps.runFallbackDelete(keys, context)
    }

    const get = async (key: StoreKey, context?: InternalOperationContext): Promise<T | undefined> => {
        const trace = traceHeadersFor(context)
        const emitter = context?.emitter
        const endpoint = resolveEndpoint(endpoints.getOne!, key)
        const startedAt = emitter ? Date.now() : 0
        try {
            const url = makeUrl(config.baseURL, endpoint)
            const headers = await getHeaders()

            // Build Request
            const request = new Request(url, { method: 'GET', headers: { ...headers, ...(trace?.headers || {}) } })

            emitter?.emit('adapter:request', {
                method: 'GET',
                endpoint,
                attempt: 1,
                payloadBytes: 0
            }, { requestId: trace?.requestId })

            const { envelope, response } = await executeRequest(request)

            const etag = etagManager.extractFromResponse(response)
            if (etag) etagManager.set(key, etag)

            emitter?.emit('adapter:response', {
                ok: response.ok,
                status: response.status,
                durationMs: emitter ? (Date.now() - startedAt) : undefined,
                itemCount: envelope.data ? 1 : 0
            }, { requestId: trace?.requestId })

            return envelope.data as T

        } catch (error) {
            emitter?.emit('adapter:response', {
                ok: false,
                status: typeof (error as any)?.status === 'number' ? (error as any).status : undefined,
                durationMs: emitter ? (Date.now() - startedAt) : undefined
            }, { requestId: trace?.requestId })
            onError(error as Error, `get(${key})`)
            return undefined
        }
    }

    const bulkGet = async (keys: StoreKey[], context?: InternalOperationContext) => {
        const concurrency = config.concurrency?.bulk ?? config.concurrency?.get ?? 5
        const limit = pLimit(concurrency)
        return Promise.all(keys.map(key => limit(() => get(key, context))))
    }

    const getAll = async (filter?: (item: T) => boolean, context?: InternalOperationContext) => {
        const trace = traceHeadersFor(context)
        const emitter = context?.emitter
        const endpoint = resolveEndpoint(endpoints.getAll!)
        const startedAt = emitter ? Date.now() : 0

        try {
            const url = makeUrl(config.baseURL, endpoint)
            const headers = await getHeaders()

            const request = new Request(url, { method: 'GET', headers: { ...headers, ...(trace?.headers || {}) } })

            emitter?.emit('adapter:request', {
                method: 'GET',
                endpoint,
                attempt: 1,
                payloadBytes: 0
            }, { requestId: trace?.requestId })

            const { envelope, response } = await executeRequest(request)

            const items: T[] = Array.isArray(envelope.data) ? envelope.data : []
            emitter?.emit('adapter:response', {
                ok: response.ok,
                status: response.status,
                durationMs: emitter ? (Date.now() - startedAt) : undefined,
                itemCount: items.length
            }, { requestId: trace?.requestId })
            return filter ? items.filter(filter) : items
        } catch (error) {
            emitter?.emit('adapter:response', {
                ok: false,
                status: typeof (error as any)?.status === 'number' ? (error as any).status : undefined,
                durationMs: emitter ? (Date.now() - startedAt) : undefined
            }, { requestId: trace?.requestId })
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

    const findMany = async (options?: FindManyOptions<T>, context?: InternalOperationContext) => {
        const optionsForQuery = options
            ? ({ ...options, traceId: undefined, explain: undefined } as any)
            : undefined

        if (config.query?.customFn) {
            return config.query.customFn(optionsForQuery || {} as any)
        }

        if (config.query?.serializer) {
            const payload = config.query.serializer(optionsForQuery || {} as any)
            return dispatchSerializedQuery(payload)
        }

        const strategy = config.query?.strategy || 'REST'
        if (strategy === 'REST' || strategy === 'Django') {
            const params = buildQueryParams(optionsForQuery, config.querySerializer)
            const url = `${config.baseURL}${resolveEndpoint(endpoints.getAll!)}?${params.toString()}`
            const headers = await getHeaders()
            const trace = traceHeadersFor(context)
            const emitter = context?.emitter

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
        const trace = traceHeadersFor(context)
        const emitter = context?.emitter

        const request = new Request(url, {
            method: 'POST',
            headers: { ...headers, ...(trace?.headers || {}), 'Content-Type': 'application/json' },
            body: JSON.stringify(optionsForQuery || {})
        })
        const startedAt = Date.now()
        try {
            emitter?.emit('adapter:request', {
                method: 'POST',
                endpoint: resolveEndpoint(endpoints.getAll!),
                attempt: 1,
                payloadBytes: utf8ByteLength(JSON.stringify(optionsForQuery || {}))
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
