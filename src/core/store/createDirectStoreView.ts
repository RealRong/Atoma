import type { CoreStore } from '../createStore'
import type { Entity, StoreHandle } from '../types'
import { createStoreView } from './createStoreView'

export function createDirectStoreView<T extends Entity, Relations = {}>(
    handle: StoreHandle<T>
): CoreStore<T, Relations> {
    return createStoreView<T, Relations>(handle, {
        writeConfig: {
            persistMode: 'direct',
            allowImplicitFetchForWrite: handle.writePolicies?.allowImplicitFetchForWrite !== false
        },
        includeServerAssignedCreate: true
    })
}
