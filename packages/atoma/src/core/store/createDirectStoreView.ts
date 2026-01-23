import type { CoreStore } from '../createStore'
import type { CoreRuntime, Entity } from '../types'
import { createStoreView } from './createStoreView'
import type { StoreHandle } from './internals/handleTypes'

export function createDirectStoreView<T extends Entity, Relations = {}>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>
): CoreStore<T, Relations> {
    return createStoreView<T, Relations>(clientRuntime, handle, {
        writeConfig: {
            writeStrategy: undefined,
            allowImplicitFetchForWrite: handle.writePolicies?.allowImplicitFetchForWrite !== false
        },
        includeServerAssignedCreate: true
    })
}
