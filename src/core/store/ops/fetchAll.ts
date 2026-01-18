import type { CoreRuntime, Entity } from '../../types'
import { resolveObservabilityContext } from '../internals/runtime'
import { executeQuery } from '../../ops/opsExecutor'
import type { StoreHandle } from '../internals/handleTypes'

export function createFetchAll<T extends Entity>(clientRuntime: CoreRuntime, handle: StoreHandle<T>) {
    const { transform } = handle

    return async () => {
        const observabilityContext = resolveObservabilityContext(clientRuntime, handle, undefined)
        const { data } = await executeQuery(clientRuntime, handle, {}, observabilityContext)
        const out: T[] = new Array(data.length)
        for (let i = 0; i < data.length; i++) {
            out[i] = transform(data[i] as T)
        }
        return out
    }
}
