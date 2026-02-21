import { HttpOperationClient } from './operation-client'
import { buildOperationExecutor } from 'atoma-backend-shared'
import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import type { HttpBackendPluginOptions } from './types'

const HTTP_EXECUTOR_ID = 'backend.http.operation'

function safeDispose(dispose?: () => void): void {
    if (typeof dispose !== 'function') return
    try {
        dispose()
    } catch {
        // ignore
    }
}

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
                }
            }
        }
    }
}
