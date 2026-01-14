import type { Entity, StoreHandle } from '../../types'
import { resolveObservabilityContext } from '../internals/runtime'
import { executeQuery } from '../internals/opsExecutor'

export function createFetchAll<T extends Entity>(handle: StoreHandle<T>) {
    const { transform } = handle

    return async () => {
        const observabilityContext = resolveObservabilityContext(handle, undefined)
        const { data } = await executeQuery(handle, {}, observabilityContext)
        const out: T[] = new Array(data.length)
        for (let i = 0; i < data.length; i++) {
            out[i] = transform(data[i] as T)
        }
        return out
    }
}
