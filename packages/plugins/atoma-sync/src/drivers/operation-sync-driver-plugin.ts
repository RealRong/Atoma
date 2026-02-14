import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { SyncTransport } from 'atoma-types/sync'
import { createOperationSyncDriver } from '#sync/transport/operation-driver'
import { SYNC_TRANSPORT_TOKEN } from '#sync/services'

export type SyncOperationDriverPluginOptions = Readonly<{
    /** Optional time source for op ids. */
    now?: () => number
    /** Overwrite existing sync transport if present. */
    overwrite?: boolean
}>

export function syncOperationDriverPlugin(options: SyncOperationDriverPluginOptions = {}): ClientPlugin {
    return {
        id: 'sync.operation-driver',
        provides: [SYNC_TRANSPORT_TOKEN],
        requires: [OPERATION_CLIENT_TOKEN],
        setup: (ctx: PluginContext) => {
            if (!options.overwrite && ctx.services.resolve(SYNC_TRANSPORT_TOKEN)) return

            const operation = ctx.services.resolve(OPERATION_CLIENT_TOKEN)
            if (!operation) {
                throw new Error('[Sync] operation client missing')
            }

            const driver: SyncTransport = createOperationSyncDriver({
                executeOperations: async (input) => {
                    return await operation.executeOperations({
                        ops: input.ops as any,
                        meta: input.meta,
                        ...(input.signal ? { signal: input.signal } : {})
                    })
                },
                ...(options.now ? { now: options.now } : {})
            })

            const unregister = ctx.services.register(SYNC_TRANSPORT_TOKEN, driver, {
                override: options.overwrite === true
            })

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
