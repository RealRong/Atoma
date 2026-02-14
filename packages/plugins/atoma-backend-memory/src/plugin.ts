import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import { MemoryOperationClient } from './operation-client'
import type { MemoryBackendPluginOptions } from './types'

export function memoryBackendPlugin(options?: MemoryBackendPluginOptions): ClientPlugin {
    return {
        id: 'memory',
        provides: [OPERATION_CLIENT_TOKEN],
        setup: (ctx) => {
            const operationClient = new MemoryOperationClient({
                ...(options?.seed ? { seed: options.seed } : {})
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
