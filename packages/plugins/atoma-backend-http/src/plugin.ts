import { HttpOperationClient } from './operation-client'
import type { ClientPlugin, PluginContext, RegisterOperationMiddleware } from 'atoma-types/client/plugins'
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
        operations: (_ctx: PluginContext, register: RegisterOperationMiddleware) => {
            const operationClient = new HttpOperationClient({
                baseURL: opts.baseURL,
                operationsPath: opts.operationsPath,
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

            register(async (req) => {
                return await operationClient.executeOperations({
                    ops: req.ops,
                    meta: req.meta,
                    ...(req.signal ? { signal: req.signal } : {})
                })
            }, { priority: 1000 })
        }
    }
}
