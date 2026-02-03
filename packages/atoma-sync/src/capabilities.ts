import type { ClientPluginContext } from 'atoma-client'
import type { SyncDriver, SyncSubscribeDriver } from '#sync/types'

export const SYNC_DRIVER_CAPABILITY_KEY = 'sync.driver'
export const SYNC_SUBSCRIBE_CAPABILITY_KEY = 'sync.subscribe'

export function registerSyncDriver(ctx: ClientPluginContext, driver: SyncDriver) {
    return ctx.capabilities.register(SYNC_DRIVER_CAPABILITY_KEY, driver)
}

export function getSyncDriver(ctx: ClientPluginContext): SyncDriver | undefined {
    return ctx.capabilities.get<SyncDriver>(SYNC_DRIVER_CAPABILITY_KEY)
}

export function registerSyncSubscribeDriver(ctx: ClientPluginContext, driver: SyncSubscribeDriver) {
    return ctx.capabilities.register(SYNC_SUBSCRIBE_CAPABILITY_KEY, driver)
}

export function getSyncSubscribeDriver(ctx: ClientPluginContext): SyncSubscribeDriver | undefined {
    return ctx.capabilities.get<SyncSubscribeDriver>(SYNC_SUBSCRIBE_CAPABILITY_KEY)
}
