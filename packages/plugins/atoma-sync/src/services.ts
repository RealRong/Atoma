import { createServiceToken } from 'atoma-types/client/services'
import type { SyncSubscribeTransport, SyncTransport } from 'atoma-types/sync'

export const SYNC_TRANSPORT_TOKEN = createServiceToken<SyncTransport>('sync.transport')
export const SYNC_SUBSCRIBE_TRANSPORT_TOKEN = createServiceToken<SyncSubscribeTransport>('sync.subscribe.transport')
