import type { PluginContext } from 'atoma-types/client/plugins'
import type { SyncSubscribeTransport, SyncTransport } from 'atoma-types/sync'

export const SYNC_DRIVER_CAPABILITY_KEY = 'sync.driver'
export const SYNC_SUBSCRIBE_CAPABILITY_KEY = 'sync.subscribe'

export function registerSyncDriver(ctx: PluginContext, driver: SyncTransport) {
    return ctx.capabilities.register(SYNC_DRIVER_CAPABILITY_KEY, driver)
}

export function getSyncDriver(ctx: PluginContext): SyncTransport | undefined {
    return ctx.capabilities.get<SyncTransport>(SYNC_DRIVER_CAPABILITY_KEY)
}

export function registerSyncSubscribeDriver(ctx: PluginContext, driver: SyncSubscribeTransport) {
    return ctx.capabilities.register(SYNC_SUBSCRIBE_CAPABILITY_KEY, driver)
}

export function getSyncSubscribeDriver(ctx: PluginContext): SyncSubscribeTransport | undefined {
    return ctx.capabilities.get<SyncSubscribeTransport>(SYNC_SUBSCRIBE_CAPABILITY_KEY)
}
