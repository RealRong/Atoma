import type { ClientPlugin, ClientPluginContext } from 'atoma-types/client'
import type { SyncDriver } from 'atoma-types/sync'
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
        init: (ctx: ClientPluginContext) => {
            if (!options.overwrite && getSyncDriver(ctx)) return

            const driver: SyncDriver = createOpsSyncDriver({
                executeOps: async (input) => {
                    const results = await ctx.runtime.io.executeOps({
                        ops: input.ops as any,
                        ...(input.signal ? { signal: input.signal } : {})
                    })
                    return { results: results as any }
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
