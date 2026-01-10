import type { CoreStore } from '../createStore'
import type { Entity, StoreHandle, StoreKey, StoreOperationOptions } from '../types'
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

function assertNoInternalOptions(options: unknown): void {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return
    if ('__atoma' in (options as any)) {
        throw new Error('[Atoma] Store.Outbox: options.__atoma 为内部保留字段，请勿传入；需要 direct 请使用 Store(...)')
    }
}

function toSyncOptions(options: StoreOperationOptions | undefined, queue: SyncQueueMode): StoreOperationOptions {
    assertNoInternalOptions(options)
    return {
        ...(options ? options : {}),
        __atoma: {
            persist: 'outbox',
            allowImplicitFetchForWrite: queue === 'local-first'
        }
    }
}

export function createSyncStoreView<T extends Entity, Relations = {}>(
    handle: StoreHandle<T>,
    viewConfig?: SyncStoreViewConfig
): SyncStore<T, Relations> {
    const queue: SyncQueueMode = viewConfig?.queue ?? 'queue'
    return createStoreView<T, Relations>(handle, {
        mapWriteOptions: (options) => toSyncOptions(options, queue),
        includeServerAssignedCreate: false
    }) as unknown as SyncStore<T, Relations>
}
