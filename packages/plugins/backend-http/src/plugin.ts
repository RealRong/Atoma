import { HttpOperationClient } from './client'
import { buildOperationExecutor } from '@atoma-js/backend-shared'
import { safeDispose } from '@atoma-js/shared'
import { OPERATION_CLIENT_TOKEN } from '@atoma-js/types/client/ops'
import type { ClientPlugin } from '@atoma-js/types/client/plugins'
import type { BackendPluginOptions } from './types'

function normalizeBaseUrl(baseURL: string): string {
    const url = String(baseURL ?? '').trim()
    if (!url) throw new Error('[Atoma] backendPlugin: baseURL 必填')
    return url
}

export function backendPlugin(options: BackendPluginOptions): ClientPlugin {
    const opts: BackendPluginOptions = {
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

            const unregisterService = ctx.services.register(OPERATION_CLIENT_TOKEN, operationClient)
            let unregisterExecution: (() => void) | undefined

            try {
                unregisterExecution = ctx.runtime.execution.register({
                    id: `backend.http:${opts.baseURL}`,
                    ...buildOperationExecutor({
                        runtime: {
                            now: ctx.runtime.now
                        },
                        operationClient
                    })
                })
            } catch (error) {
                safeDispose(unregisterService)
                throw error
            }

            return {
                dispose: () => {
                    safeDispose(unregisterExecution)
                    safeDispose(unregisterService)
                    safeDispose(() => operationClient.dispose())
                }
            }
        }
    }
}
