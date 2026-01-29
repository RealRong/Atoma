import type { CoreRuntime, StoreToken } from '#core'
import type { StoreHandle } from '#core/store/internals/handleTypes'

export class StoreHandleResolver {
    constructor(private readonly runtime: CoreRuntime) {}

    resolve = (storeName: StoreToken, tag: string): StoreHandle<any> => {
        const name = String(storeName)
        const key = this.runtime.toStoreKey(name)
        const direct = this.runtime.handles.get(key)
        if (direct) return direct

        // Lazy creation: create store/handle via runtime store resolver (client runtime does).
        try {
            this.runtime.stores.resolveStore(name)
        } catch {
            // ignore
        }

        const after = this.runtime.handles.get(key)
        if (after) return after

        throw new Error(`[Atoma] ${tag}: 未找到 store handle（storeName=${name}）`)
    }
}
