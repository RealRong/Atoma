import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import type { ExecutionRoute } from 'atoma-types/core'
import { buildOperationExecutor } from 'atoma-backend-shared'
import { MemoryOperationClient } from './operation-client'
import type { MemoryBackendPluginOptions } from './types'

const MEMORY_EXECUTOR_ID = 'backend.memory.operation'
export const MEMORY_ROUTE: ExecutionRoute = 'direct-memory'

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
                        [MEMORY_ROUTE]: {
                            query: MEMORY_EXECUTOR_ID,
                            write: MEMORY_EXECUTOR_ID
                        }
                    }
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
