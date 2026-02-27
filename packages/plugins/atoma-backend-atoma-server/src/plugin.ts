import { HttpOperationClient } from 'atoma-backend-http'
import { buildOperationExecutor } from 'atoma-backend-shared'
import { safeDispose } from 'atoma-shared'
import { OPERATION_CLIENT_TOKEN, WRITE_COORDINATOR_TOKEN } from 'atoma-types/client/ops'
import { SYNC_TRANSPORT_TOKEN } from 'atoma-types/client/sync'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import { createSyncTransport } from './sync/createSyncTransport'
import type { AtomaServerBackendPluginOptions } from './types'
import { createWriteCoordinator } from './write/createWriteCoordinator'

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
        provides: [OPERATION_CLIENT_TOKEN, WRITE_COORDINATOR_TOKEN, SYNC_TRANSPORT_TOKEN],
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
            const syncTransport = createSyncTransport({
                baseURL: normalizedOptions.baseURL,
                headers: normalizedOptions.headers,
                fetchFn: normalizedOptions.fetchFn,
                retry: normalizedOptions.retry,
                onRequest: normalizedOptions.onRequest,
                onResponse: normalizedOptions.onResponse,
                syncPaths: normalizedOptions.syncPaths
            })

            const writeCoordinator = createWriteCoordinator(ctx.runtime)
            const unregisterService = ctx.services.register(OPERATION_CLIENT_TOKEN, operationClient)
            const unregisterWriteCoordinator = ctx.services.register(WRITE_COORDINATOR_TOKEN, writeCoordinator)
            const unregisterSyncTransport = ctx.services.register(SYNC_TRANSPORT_TOKEN, syncTransport)
            const unregisterWriteStart = ctx.events.on('writeStart', ({ storeName, writeEntries }) => {
                writeCoordinator.capture({
                    storeName,
                    entries: writeEntries
                })
            })
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
                safeDispose(unregisterWriteStart)
                safeDispose(unregisterSyncTransport)
                safeDispose(unregisterWriteCoordinator)
                safeDispose(unregisterService)
                safeDispose(() => operationClient.dispose())
                throw error
            }

            return {
                dispose: () => {
                    safeDispose(unregisterExecution)
                    safeDispose(unregisterWriteStart)
                    safeDispose(unregisterSyncTransport)
                    safeDispose(unregisterWriteCoordinator)
                    safeDispose(unregisterService)
                    safeDispose(() => operationClient.dispose())
                }
            }
        }
    }
}
