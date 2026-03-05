import type { ClientPlugin, PluginContext } from '@atoma-js/types/client/plugins'
import { SYNC_TRANSPORT_TOKEN } from '@atoma-js/types/client/sync'
import { SyncController } from './controller/SyncController'
import type { SyncExtension, SyncPluginOptions } from './types'

export function syncPlugin(options: SyncPluginOptions): ClientPlugin<SyncExtension> {
    return {
        id: 'sync',
        requires: [SYNC_TRANSPORT_TOKEN],
        setup: (ctx: PluginContext) => setupSyncPlugin(ctx, options)
    }
}

function setupSyncPlugin(
    ctx: PluginContext,
    options: SyncPluginOptions
): { extension: SyncExtension; dispose: () => void } {
    const controller = new SyncController({
        ctx,
        options
    })

    controller.parse()
    controller.prepare()

    return {
        extension: controller.mount(),
        dispose: controller.dispose
    }
}
