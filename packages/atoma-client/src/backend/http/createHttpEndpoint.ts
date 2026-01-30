import { HttpOpsClient, type HttpOpsClientConfig } from './HttpOpsClient'
import type { Driver, Endpoint } from '../../drivers/types'

export type CreateHttpEndpointOptions = Readonly<{
    baseURL: string
    id?: string
    role?: string
    opsPath?: HttpOpsClientConfig['opsPath']
    headers?: HttpOpsClientConfig['headers']
    retry?: HttpOpsClientConfig['retry']
    fetchFn?: HttpOpsClientConfig['fetchFn']
    onRequest?: NonNullable<HttpOpsClientConfig['interceptors']>['onRequest']
    onResponse?: NonNullable<HttpOpsClientConfig['interceptors']>['onResponse']
    responseParser?: NonNullable<HttpOpsClientConfig['interceptors']>['responseParser']
    batch?: HttpOpsClientConfig['batch']
}>

function normalizeBaseUrl(baseURL: string): string {
    const url = String(baseURL ?? '').trim()
    if (!url) throw new Error('[Atoma] createHttpEndpoint: baseURL 必填')
    return url
}

export function createHttpEndpoint(options: CreateHttpEndpointOptions): Endpoint {
    const baseURL = normalizeBaseUrl(options.baseURL)
    const id = (typeof options.id === 'string' && options.id.trim()) ? options.id.trim() : baseURL
    const role = (typeof options.role === 'string' && options.role.trim()) ? options.role.trim() : 'ops'

    const opsClient = new HttpOpsClient({
        baseURL,
        opsPath: options.opsPath,
        headers: options.headers,
        retry: options.retry,
        fetchFn: options.fetchFn,
        interceptors: {
            onRequest: options.onRequest,
            onResponse: options.onResponse,
            responseParser: options.responseParser
        },
        batch: options.batch
    })

    const driver: Driver = {
        executeOps: async (req) => {
            return await opsClient.executeOps({
                ops: req.ops,
                meta: req.meta,
                ...(req.signal ? { signal: req.signal } : {}),
                ...(req.context ? { context: req.context } : {})
            })
        }
    }

    return {
        id,
        role,
        driver
    }
}
