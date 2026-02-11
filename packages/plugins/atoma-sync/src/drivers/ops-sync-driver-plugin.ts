import { getOpsClient } from 'atoma-types/client/ops'
import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import type { SyncTransport } from 'atoma-types/sync'
import { createOpsSyncDriver } from '#sync/transport'
import { getSyncDriver, registerSyncDriver } from '#sync/capabilities'

export type SyncOpsDriverPluginOptions = Readonly<{
    /** Optional time source for op ids. */
    now?: () => number
    /** Overwrite existing sync.driver if present. */
    overwrite?: boolean
}>

export function syncOpsDriverPlugin(options: SyncOpsDriverPluginOptions = {}): ClientPlugin {
    return {
        id: 'sync.ops-driver',
        init: (ctx: PluginContext) => {
            if (!options.overwrite && getSyncDriver(ctx)) return

            const opsClient = getOpsClient(ctx.capabilities)
            if (!opsClient) {
                throw new Error('[atoma-sync] sync.ops-driver: missing client.ops capability')
            }

            const driver: SyncTransport = createOpsSyncDriver({
                executeOps: async (input) => {
                    return await opsClient.executeOps({
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
