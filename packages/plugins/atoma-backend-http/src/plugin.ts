import { HttpOperationClient } from './operation-client'
import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { ClientPlugin } from 'atoma-types/client/plugins'
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
        provides: [OPERATION_CLIENT_TOKEN],
        setup: (ctx) => {
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

            const unregister = ctx.services.register(OPERATION_CLIENT_TOKEN, operationClient)

            return {
                dispose: () => {
                    try {
                        unregister?.()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}
