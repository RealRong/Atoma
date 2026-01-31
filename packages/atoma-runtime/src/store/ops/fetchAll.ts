import type { CoreRuntime, Entity } from 'atoma-core/internal'
import { resolveObservabilityContext } from '../internals/storeHandleManager'
import type { StoreHandle } from 'atoma-core/internal'

export function createFetchAll<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    return async () => {
        const observabilityContext = resolveObservabilityContext(clientRuntime, handle, undefined)
        const { data } = await clientRuntime.io.query(handle, {}, observabilityContext)
        const out: T[] = []
        for (let i = 0; i < data.length; i++) {
            const processed = await clientRuntime.transform.writeback(handle, data[i] as T)
            if (processed !== undefined) {
                out.push(processed)
            }
        }
        return out
    }
}
