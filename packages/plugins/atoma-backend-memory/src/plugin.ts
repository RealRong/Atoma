import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import { buildOperationExecutor } from 'atoma-backend-shared'
import { safeDispose } from 'atoma-shared'
import { MemoryOperationClient } from './operation-client'
import type { MemoryBackendPluginOptions } from './types'

const MEMORY_EXECUTOR_ID = 'backend.memory.operation'

export function memoryBackendPlugin(options?: MemoryBackendPluginOptions): ClientPlugin {
    return {
        id: 'memory',
        provides: [OPERATION_CLIENT_TOKEN],
        setup: (ctx) => {
            const operationClient = new MemoryOperationClient({
                ...(options?.seed ? { seed: options.seed } : {})
            })

            const unregisterService = ctx.services.register(OPERATION_CLIENT_TOKEN, operationClient)
            let unregisterExecution: (() => void) | undefined

            try {
                unregisterExecution = ctx.runtime.execution.register({
                    id: MEMORY_EXECUTOR_ID,
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
