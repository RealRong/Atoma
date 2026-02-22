import { HttpOperationClient } from 'atoma-backend-http'
import { buildOperationExecutor } from 'atoma-backend-shared'
import { OPERATION_CLIENT_TOKEN, WRITE_COORDINATOR_TOKEN } from 'atoma-types/client/ops'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import type { AtomaServerBackendPluginOptions } from './types'
import { createWriteCoordinator } from './write/createWriteCoordinator'

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
    if (!url) throw new Error('[Atoma] AtomaServerBackendPlugin: baseURL 必填')
    return url
}

export function atomaServerBackendPlugin(options: AtomaServerBackendPluginOptions): ClientPlugin {
    const normalizedOptions = {
        ...options,
        baseURL: normalizeBaseUrl(options.baseURL)
    }

    return {
        id: `atoma-server:${normalizedOptions.baseURL}`,
        provides: [OPERATION_CLIENT_TOKEN, WRITE_COORDINATOR_TOKEN],
        setup: (ctx) => {
            const operationClient = new HttpOperationClient({
                baseURL: normalizedOptions.baseURL,
                operationsPath: normalizedOptions.operationsPath,
                headers: normalizedOptions.headers,
                retry: normalizedOptions.retry,
                fetchFn: normalizedOptions.fetchFn,
                interceptors: {
                    onRequest: normalizedOptions.onRequest,
                    onResponse: normalizedOptions.onResponse,
                    responseParser: normalizedOptions.responseParser
                },
                batch: normalizedOptions.batch
            })

            const writeCoordinator = createWriteCoordinator(ctx.runtime)
            const unregisterService = ctx.services.register(OPERATION_CLIENT_TOKEN, operationClient)
            const unregisterWriteCoordinator = ctx.services.register(WRITE_COORDINATOR_TOKEN, writeCoordinator)
            let unregisterExecution: (() => void) | undefined

            try {
                unregisterExecution = ctx.runtime.execution.register({
                    id: `backend.atoma-server:${normalizedOptions.baseURL}`,
                    ...buildOperationExecutor({
                        runtime: {
                            now: ctx.runtime.now
                        },
                        operationClient,
                        writeEntryEncoder: ({ request, entries }) => {
                            return writeCoordinator.encode({
                                storeName: request.handle.storeName,
                                entries
                            })
                        }
                    })
                })
            } catch (error) {
                safeDispose(unregisterWriteCoordinator)
                safeDispose(unregisterService)
                throw error
            }

            return {
                dispose: () => {
                    safeDispose(unregisterExecution)
                    safeDispose(unregisterWriteCoordinator)
                    safeDispose(unregisterService)
                }
            }
        }
    }
}
