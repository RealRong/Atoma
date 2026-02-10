import type { PersistResult } from 'atoma-types/runtime'
import { HttpOpsClient } from './ops-client'
import type { ClientPlugin, PluginContext, ReadRequest, Register } from 'atoma-types/client/plugins'
import { persistViaOps, queryViaOps } from 'atoma-backend-shared'
import type { HttpBackendPluginOptions } from './types'

function normalizeBaseUrl(baseURL: string): string {
    const url = String(baseURL ?? '').trim()
    if (!url) throw new Error('[Atoma] HttpBackendPlugin: baseURL 必填')
    return url
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
                return await persistViaOps(ctx, req)
            }, { priority: 1000 })
        }
    }
}
