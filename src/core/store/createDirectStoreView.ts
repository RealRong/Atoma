import type { CoreStore } from '../createStore'
import type { ClientRuntime, Entity, StoreHandle } from '../types'
import { createStoreView } from './createStoreView'

export function createDirectStoreView<T extends Entity, Relations = {}>(
    clientRuntime: ClientRuntime,
    handle: StoreHandle<T>
): CoreStore<T, Relations> {
    return createStoreView<T, Relations>(clientRuntime, handle, {
        writeConfig: {
            persistMode: 'direct',
            allowImplicitFetchForWrite: handle.writePolicies?.allowImplicitFetchForWrite !== false
        },
        includeServerAssignedCreate: true
    })
}
