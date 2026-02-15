import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import { buildOperationExecutor } from 'atoma-backend-shared'
import { MemoryOperationClient } from './operation-client'
import type { MemoryBackendPluginOptions } from './types'

const MEMORY_EXECUTOR_ID = 'backend.memory.operation'
const MEMORY_ROUTE_ID = 'direct-memory'

function safeDispose(dispose?: () => void): void {
    if (typeof dispose !== 'function') return
    try {
        dispose()
    } catch {
        // ignore
    }
}

export function memoryBackendPlugin(options?: MemoryBackendPluginOptions): ClientPlugin {
    return {
        id: 'memory',
        provides: [OPERATION_CLIENT_TOKEN],
        setup: (ctx) => {
            const operationClient = new MemoryOperationClient({
                ...(options?.seed ? { seed: options.seed } : {})
            })

            const unregisterService = ctx.services.register(OPERATION_CLIENT_TOKEN, operationClient)
            let unregisterRoute: (() => void) | undefined

            try {
                unregisterRoute = ctx.runtime.execution.apply({
                    id: 'backend.memory.route',
                    executors: {
                        [MEMORY_EXECUTOR_ID]: buildOperationExecutor({
                            runtime: {
                                now: ctx.runtime.now
                            },
                            operationClient
                        })
                    },
                    routes: {
                        [MEMORY_ROUTE_ID]: {
                            query: MEMORY_EXECUTOR_ID,
                            write: MEMORY_EXECUTOR_ID
                        }
                    },
                    defaultRoute: MEMORY_ROUTE_ID
                })
            } catch (error) {
                safeDispose(unregisterService)
                throw error
            }

            return {
                dispose: () => {
                    safeDispose(unregisterRoute)
                    safeDispose(unregisterService)
                }
            }
        }
    }
}
