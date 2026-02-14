import { createServiceToken } from 'atoma-types/client/services'
import type { PluginContext } from 'atoma-types/client/plugins'
import type { SyncSubscribeTransport, SyncTransport } from 'atoma-types/sync'

export const SYNC_TRANSPORT_TOKEN = createServiceToken<SyncTransport>('sync.transport')
export const SYNC_SUBSCRIBE_TRANSPORT_TOKEN = createServiceToken<SyncSubscribeTransport>('sync.subscribe.transport')

export function registerSyncTransport(
    ctx: PluginContext,
    driver: SyncTransport,
    opts?: { override?: boolean }
) {
    return ctx.services.register(SYNC_TRANSPORT_TOKEN, driver, opts)
}

export function resolveSyncTransport(ctx: PluginContext): SyncTransport | undefined {
    return ctx.services.resolve(SYNC_TRANSPORT_TOKEN)
}

export function registerSyncSubscribeTransport(
    ctx: PluginContext,
    driver: SyncSubscribeTransport,
    opts?: { override?: boolean }
) {
    return ctx.services.register(SYNC_SUBSCRIBE_TRANSPORT_TOKEN, driver, opts)
}

export function resolveSyncSubscribeTransport(ctx: PluginContext): SyncSubscribeTransport | undefined {
    return ctx.services.resolve(SYNC_SUBSCRIBE_TRANSPORT_TOKEN)
}
