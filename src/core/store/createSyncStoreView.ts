import type { CoreStore } from '../createStore'
import type { Entity, StoreHandle, StoreKey, StoreOperationOptions } from '../types'
import { createStoreView } from './createStoreView'

export type SyncStore<T extends Entity, Relations = {}> =
    Omit<CoreStore<T, Relations>, 'createServerAssignedOne' | 'createServerAssignedMany'>

type SyncStoreWriteMode = 'intent-only' | 'local-first'

type SyncStoreViewConfig = {
    /**
     * queued 写入策略：
     * - intent-only（默认）：只入队；禁止 cache miss 隐式补读
     * - local-first：先本地 durable 再入队；允许本地 cache miss 隐式补读
     */
    mode?: SyncStoreWriteMode
}

function assertNoInternalOptions(options: unknown): void {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return
    if ('__atoma' in (options as any)) {
        throw new Error('[Atoma] Sync.Store: options.__atoma 为内部保留字段，请勿传入；需要 direct 请使用 Store(...)')
    }
}

function toSyncOptions(options: StoreOperationOptions | undefined, mode: SyncStoreWriteMode): StoreOperationOptions {
    assertNoInternalOptions(options)
    return {
        ...(options ? options : {}),
        __atoma: {
            persist: 'outbox',
            allowImplicitFetchForWrite: mode === 'local-first'
        }
    }
}

export function createSyncStoreView<T extends Entity, Relations = {}>(
    handle: StoreHandle<T>,
    viewConfig?: SyncStoreViewConfig
): SyncStore<T, Relations> {
    const mode: SyncStoreWriteMode = viewConfig?.mode ?? 'intent-only'
    return createStoreView<T, Relations>(handle, {
        mapWriteOptions: (options) => toSyncOptions(options, mode),
        includeServerAssignedCreate: false
    }) as unknown as SyncStore<T, Relations>
}
