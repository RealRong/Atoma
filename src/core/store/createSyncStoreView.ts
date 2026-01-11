import type { CoreStore } from '../createStore'
import type { Entity, StoreHandle } from '../types'
import { createStoreView } from './createStoreView'

export type SyncStore<T extends Entity, Relations = {}> =
    Omit<CoreStore<T, Relations>, 'createServerAssignedOne' | 'createServerAssignedMany'>

type SyncQueueMode = 'queue' | 'local-first'

type SyncStoreViewConfig = {
    /**
     * queued 写入策略：
     * - queue（默认）：只入队；禁止 cache miss 隐式补读
     * - local-first：先本地 durable 再入队；允许本地 cache miss 隐式补读
     */
    queue?: SyncQueueMode
}

export function createSyncStoreView<T extends Entity, Relations = {}>(
    handle: StoreHandle<T>,
    viewConfig?: SyncStoreViewConfig
): SyncStore<T, Relations> {
    const queue: SyncQueueMode = viewConfig?.queue ?? 'queue'
    const allowImplicitFetchForWrite = queue === 'local-first'
        && handle.writePolicies?.allowImplicitFetchForWrite !== false
    return createStoreView<T, Relations>(handle, {
        writeConfig: {
            persistMode: 'outbox',
            allowImplicitFetchForWrite
        },
        includeServerAssignedCreate: false
    }) as unknown as SyncStore<T, Relations>
}
