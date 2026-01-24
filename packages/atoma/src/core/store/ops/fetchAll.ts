import type { CoreRuntime, Entity } from '../../types'
import { storeHandleManager } from '../internals/storeHandleManager'
import type { StoreHandle } from '../internals/handleTypes'

export function createFetchAll<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async () => {
        const observabilityContext = storeHandleManager.resolveObservabilityContext(clientRuntime, handle, undefined)
        const { data } = await clientRuntime.io.query(handle, {}, observabilityContext)
        const out: T[] = []
        for (let i = 0; i < data.length; i++) {
            const processed = await clientRuntime.dataProcessor.writeback(handle, data[i] as T)
            if (processed !== undefined) {
                out.push(processed)
            }
        }
        return out
    }
}
