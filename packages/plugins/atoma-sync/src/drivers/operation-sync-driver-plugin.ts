import { getOperationClient } from 'atoma-types/client/ops'
import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import type { SyncTransport } from 'atoma-types/sync'
import { createOperationSyncDriver } from '#sync/transport'
import { getSyncDriver, registerSyncDriver } from '#sync/capabilities'

export type SyncOperationDriverPluginOptions = Readonly<{
    /** Optional time source for op ids. */
    now?: () => number
    /** Overwrite existing sync.driver if present. */
    overwrite?: boolean
}>

export function syncOperationDriverPlugin(options: SyncOperationDriverPluginOptions = {}): ClientPlugin {
    return {
        id: 'sync.operation-driver',
        init: (ctx: PluginContext) => {
            if (!options.overwrite && getSyncDriver(ctx)) return

            const operationClient = getOperationClient(ctx.capabilities)
            if (!operationClient) {
                throw new Error('[atoma-sync] sync.operation-driver: missing client.operations capability')
            }

            const driver: SyncTransport = createOperationSyncDriver({
                executeOperations: async (input) => {
                    return await operationClient.executeOperations({
                        ops: input.ops as any,
                        meta: input.meta,
                        ...(input.signal ? { signal: input.signal } : {})
                    })
                },
                ...(options.now ? { now: options.now } : {})
            })

            const unregister = registerSyncDriver(ctx, driver)

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
