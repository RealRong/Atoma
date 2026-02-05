import { Protocol } from 'atoma-protocol'
import type { PersistResult } from 'atoma-types/runtime'
import { HttpOpsClient, type HttpOpsClientConfig } from './backend/http/HttpOpsClient'
import type { ClientPlugin, PluginContext, ReadRequest, Register } from 'atoma-types/client'

export type HttpBackendPluginOptions = Readonly<{
    baseURL: string
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
    if (!url) throw new Error('[Atoma] HttpBackendPlugin: baseURL 必填')
    return url
}

async function queryViaOps(ctx: PluginContext, req: ReadRequest) {
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

export function httpBackendPlugin(options: HttpBackendPluginOptions): ClientPlugin {
    const opts: HttpBackendPluginOptions = {
        ...options,
        baseURL: normalizeBaseUrl(options.baseURL)
    }

    return {
        id: `http:${opts.baseURL}`,
        register: (ctx: PluginContext, register: Register) => {
            const opsClient = new HttpOpsClient({
                baseURL: opts.baseURL,
                opsPath: opts.opsPath,
                headers: opts.headers,
                retry: opts.retry,
                fetchFn: opts.fetchFn,
                interceptors: {
                    onRequest: opts.onRequest,
                    onResponse: opts.onResponse,
                    responseParser: opts.responseParser
                },
                batch: opts.batch
            })

            register('io', async (req) => {
                return await opsClient.executeOps({
                    ops: req.ops,
                    meta: req.meta,
                    ...(req.signal ? { signal: req.signal } : {})
                })
            }, { priority: 1000 })

            register('read', async (req: ReadRequest, _ctx, _next) => {
                return await queryViaOps(ctx, req)
            }, { priority: 1000 })

            register('persist', async (req, _ctx, _next): Promise<PersistResult<any>> => {
                const results = await ctx.runtime.io.executeOps({
                    ops: req.writeOps as any
                })
                return {
                    status: 'confirmed',
                    ...(results.length ? { results } : {})
                }
            }, { priority: 1000 })
        }
    }
}
