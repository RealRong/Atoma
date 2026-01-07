import type { CoreStore } from '../createStore'
import type { Entity, StoreHandle, StoreOperationOptions } from '../types'
import { createStoreView } from './createStoreView'

function withDirectOptions<TOptions extends StoreOperationOptions | undefined>(options: TOptions): TOptions {
    const anyOptions = (options && typeof options === 'object' && !Array.isArray(options)) ? (options as any) : {}
    const base = (anyOptions.__atoma && typeof anyOptions.__atoma === 'object' && !Array.isArray(anyOptions.__atoma))
        ? anyOptions.__atoma
        : {}

    const requestedPersist = base.persist
    if (requestedPersist === 'outbox') {
        throw new Error('[Atoma] Store: 不允许 outbox persist（请使用 Sync.Store(...)）')
    }

    return options
}

export function createDirectStoreView<T extends Entity, Relations = {}>(
    handle: StoreHandle<T>
): CoreStore<T, Relations> {
    return createStoreView<T, Relations>(handle, {
        mapWriteOptions: withDirectOptions,
        includeServerAssignedCreate: true
    })
}
