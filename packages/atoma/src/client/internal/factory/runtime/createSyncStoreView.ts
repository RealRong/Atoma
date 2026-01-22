import type { CoreRuntime, Entity } from '#core'
import { createStoreView } from '#core/store/createStoreView'
import type { StoreHandle } from '#core/store/internals/handleTypes'
import type { SyncStore } from '#client/types/syncStore'

export type ClientSyncStoreQueueMode = 'queue' | 'local-first'

export type ClientSyncStoreViewConfig = Readonly<{
    queue?: ClientSyncStoreQueueMode
}>

export function createSyncStoreView<T extends Entity, Relations = {}>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>,
    viewConfig?: ClientSyncStoreViewConfig
): SyncStore<T, Relations> {
    const queue: ClientSyncStoreQueueMode = viewConfig?.queue ?? 'queue'

    const allowImplicitFetchForWrite = (queue === 'local-first')
        && handle.writePolicies?.allowImplicitFetchForWrite !== false

    const persistKey = queue === 'local-first'
        ? 'sync:local-first'
        : 'sync:queue'

    return createStoreView<T, Relations>(clientRuntime, handle, {
        writeConfig: {
            persistKey,
            allowImplicitFetchForWrite
        },
        includeServerAssignedCreate: false
    }) as unknown as SyncStore<T, Relations>
}

