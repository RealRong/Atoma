import pLimit from 'p-limit'
import { normalizeFindManyResponse, buildQueryParams } from './query'
import { makeUrl, resolveEndpoint } from './request'
import type { HTTPAdapterConfig } from '../HTTPAdapter'
import { BulkOperationHandler } from './bulkOperations'
import { ETagManager } from './etagManager'
import type { HTTPClient } from './client'
import type { SyncOrchestrator } from './syncOrchestrator'
import type { StoreKey, FindManyOptions, PageInfo, Entity } from '../../core/types'
import type { ObservabilityContext } from '#observability'
import { createHttpJsonPipeline } from './transport/pipeline'

export interface OperationExecutors<T extends Entity> {
    put: (key: StoreKey, value: T, context?: ObservabilityContext) => Promise<void>
    bulkPut: (items: T[], context?: ObservabilityContext) => Promise<void>
    delete: (key: StoreKey, context?: ObservabilityContext) => Promise<void>
    bulkDelete: (keys: StoreKey[], context?: ObservabilityContext) => Promise<void>
    get: (key: StoreKey, context?: ObservabilityContext) => Promise<T | undefined>
    bulkGet: (keys: StoreKey[], context?: ObservabilityContext) => Promise<(T | undefined)[]>
    getAll: (filter?: (item: T) => boolean, context?: ObservabilityContext) => Promise<T[]>
    findMany: (options?: FindManyOptions<T>, context?: ObservabilityContext) => Promise<{ data: T[]; pageInfo?: PageInfo }>
}

type Deps<T extends Entity> = {
    config: HTTPAdapterConfig<T>
    client: HTTPClient<T>
    bulkOps: BulkOperationHandler<T>
    etagManager: ETagManager
    fetchWithRetry: (input: RequestInfo, init?: RequestInit) => Promise<Response>
    getHeaders: () => Promise<Record<string, string>>
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

    const pipeline = createHttpJsonPipeline<T>({
        fetchFn: fetchWithRetry,
        getHeaders,
        interceptors: {
            onRequest: config.onRequest,
            onResponse: config.onResponse,
            responseParser: config.responseParser
        }
    })

    const put = async (key: StoreKey, value: T, context?: ObservabilityContext) => {
        await orchestrator.handleWithOfflineFallback(
            { type: 'put', key, value },
            () => client.put(
                key,
                value,
                undefined,
                context
            )
        )
    }

    const del = async (key: StoreKey, context?: ObservabilityContext) => {
        await orchestrator.handleWithOfflineFallback(
            { type: 'delete', key },
            () => client.delete(
                key,
                undefined,
                context
            )
        )
    }

    const bulkPut = async (items: T[], context?: ObservabilityContext) => {
        if (config.endpoints!.bulkUpdate) {
            await client.bulkUpdate(
                items,
                undefined,
                context
            )
            return
        }
        await bulkOps.runFallbackPut(items, context)
    }

    const bulkDelete = async (keys: StoreKey[], context?: ObservabilityContext) => {
        if (config.endpoints!.bulkDelete) {
            await client.bulkDelete(
                keys,
                undefined,
                context
            )
            return
        }

        const qp = config.endpoints!.bulkDeleteQueryParam
        if (qp) {
            const endpoint = resolveEndpoint(qp.path)
            const url = `${config.baseURL}${endpoint}?${qp.param}=${keys.join(',')}`
            const maxLen = qp.maxUrlLength ?? 1800
            if (url.length <= maxLen) {
                const { response } = await pipeline.execute({
                    url,
                    endpoint,
                    method: 'DELETE',
                    context
                })
                if (response.ok) {
                    keys.forEach(k => etagManager.delete(k))
                    return
                }
            }
        }

        await bulkOps.runFallbackDelete(keys, context)
    }

    const get = async (key: StoreKey, context?: ObservabilityContext): Promise<T | undefined> => {
        const endpoint = resolveEndpoint(endpoints.getOne!, key)
        try {
            const url = makeUrl(config.baseURL, endpoint)
            const { envelope, response } = await pipeline.execute({
                url,
                endpoint,
                method: 'GET',
                context
            })

            const etag = etagManager.extractFromResponse(response)
            if (etag) etagManager.set(key, etag)
            const data = Array.isArray(envelope.data) ? envelope.data[0] : envelope.data
            return data as T | undefined

        } catch (error) {
            onError(error as Error, `get(${key})`)
            return undefined
        }
    }

    const bulkGet = async (keys: StoreKey[], context?: ObservabilityContext) => {
        const concurrency = config.concurrency?.bulk ?? config.concurrency?.get ?? 5
        const limit = pLimit(concurrency)
        return Promise.all(keys.map(key => limit(() => get(key, context))))
    }

    const getAll = async (filter?: (item: T) => boolean, context?: ObservabilityContext) => {
        const endpoint = resolveEndpoint(endpoints.getAll!)

        try {
            const url = makeUrl(config.baseURL, endpoint)
            const { envelope } = await pipeline.execute({
                url,
                endpoint,
                method: 'GET',
                context
            })

            const items: T[] = Array.isArray(envelope.data) ? envelope.data : []
            return filter ? items.filter(filter) : items
        } catch (error) {
            onError(error as Error, 'getAll')
            return []
        }
    }

    const dispatchSerializedQuery = async (payload: URLSearchParams | object, context?: ObservabilityContext) => {
        // URLSearchParams → GET
        if (payload instanceof URLSearchParams) {
            const endpoint = resolveEndpoint(endpoints.getAll!)
            const url = `${config.baseURL}${endpoint}?${payload.toString()}`
            const { envelope } = await pipeline.execute({
                url,
                endpoint,
                method: 'GET',
                context
            })

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
        const endpoint = resolveEndpoint(endpoints.getAll!)
        const url = `${config.baseURL}${endpoint}`
        const { envelope } = await pipeline.execute({
            url,
            endpoint,
            method: 'POST',
            body: payload,
            context
        })

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

    const findMany = async (options?: FindManyOptions<T>, context?: ObservabilityContext) => {
        const optionsForQuery = options
            ? ({ ...options, traceId: undefined, explain: undefined } as any)
            : undefined

        if (config.query?.customFn) {
            return config.query.customFn(optionsForQuery || {} as any)
        }

        if (config.query?.serializer) {
            const payload = config.query.serializer(optionsForQuery || {} as any)
            return dispatchSerializedQuery(payload, context)
        }

        const strategy = config.query?.strategy || 'REST'
        if (strategy === 'REST' || strategy === 'Django') {
            const params = buildQueryParams(optionsForQuery, config.querySerializer)
            try {
                const endpoint = resolveEndpoint(endpoints.getAll!)
                const url = `${config.baseURL}${endpoint}?${params.toString()}`
                const { envelope } = await pipeline.execute({
                    url,
                    endpoint,
                    method: 'GET',
                    context
                })

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
            } catch (error) {
                throw error
            }
        }

        try {
            const endpoint = resolveEndpoint(endpoints.getAll!)
            const url = `${config.baseURL}${endpoint}`
            const { envelope } = await pipeline.execute({
                url,
                endpoint,
                method: 'POST',
                body: optionsForQuery || {},
                context
            })

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
        } catch (error) {
            throw error
        }
    }

    return { put, bulkPut, delete: del, bulkDelete, get, bulkGet, getAll, findMany }
}
