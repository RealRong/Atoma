import type { Entity, StoreHandle } from '../../types'
import { resolveObservabilityContext } from '../internals/runtime'

export function createFetchAll<T extends Entity>(handle: StoreHandle<T>) {
    const { dataSource, transform } = handle

    return async () => {
        const observabilityContext = resolveObservabilityContext(handle, undefined)
        const raw = await dataSource.getAll(undefined, observabilityContext)
        const out: T[] = new Array(raw.length)
        for (let i = 0; i < raw.length; i++) {
            out[i] = transform(raw[i] as T)
        }
        return out
    }
}

