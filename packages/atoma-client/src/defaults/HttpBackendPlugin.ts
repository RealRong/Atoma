import { Protocol } from 'atoma-protocol'
import type { PersistResult } from 'atoma-types/runtime'
import { HttpOpsClient, type HttpOpsClientConfig } from '../backend/http/HttpOpsClient'
import type { Driver, Endpoint } from 'atoma-types/client'
import type { ClientPlugin, PluginContext, ReadRequest, Register } from 'atoma-types/client'

type CreateHttpEndpointOptions = Readonly<{
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

function createHttpEndpoint(options: CreateHttpEndpointOptions): Endpoint {
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
                ...(req.signal ? { signal: req.signal } : {})
            })
        }
    }

    return {
        id,
        role,
        driver
    }
}

export class HttpBackendPlugin implements ClientPlugin {
    readonly id: string
    private readonly baseURL: string

    constructor(args: { baseURL: string }) {
        this.baseURL = String(args.baseURL ?? '').trim()
        if (!this.baseURL) throw new Error('[Atoma] HttpBackendPlugin: baseURL 必填')
        this.id = `http:${this.baseURL}`
    }

    register(ctx: PluginContext, register: Register) {
        const endpoint = createHttpEndpoint({ baseURL: this.baseURL, role: 'ops' })
        ctx.endpoints.register(endpoint)

        register('io', async (req) => {
            return await endpoint.driver.executeOps(req)
        }, { priority: 1000 })

        register('read', async (req: ReadRequest, _ctx, _next) => {
            return await this.queryViaOps(ctx, req)
        }, { priority: 1000 })

        register('persist', async (req, _ctx, _next): Promise<PersistResult<any>> => {
            const normalized = await ctx.runtime.persistence.executeWriteOps<any>({
                ops: req.writeOps as any
            })
            return {
                status: 'confirmed',
                ...(normalized.ack ? { ack: normalized.ack } : {})
            }
        }, { priority: 1000 })
    }

    private queryViaOps = async (ctx: PluginContext, req: ReadRequest) => {
        const opId = Protocol.ids.createOpId('q', { now: ctx.runtime.now })
        const op = Protocol.ops.build.buildQueryOp({
            opId,
            resource: String(req.storeName),
            query: req.query
        })
        const results = await ctx.runtime.io.executeOps({
            ops: [op],
            ...(req.signal ? { signal: req.signal } : {})
        })
        const result = results[0]
        if (!result) throw new Error('[Atoma] Missing query result')
        if (!(result as any).ok) {
            const msg = ((result as any).error && typeof (result as any).error.message === 'string')
                ? (result as any).error.message
                : '[Atoma] Query failed'
            throw new Error(msg)
        }
        const data = Protocol.ops.validate.assertQueryResultData((result as any).data)
        return {
            data: Array.isArray((data as any)?.data) ? ((data as any).data as unknown[]) : [],
            pageInfo: (data as any)?.pageInfo
        }
    }
}
