import { PrimitiveAtom } from 'jotai/vanilla'
import { StoreKey, IStore } from './types'

type StoreAccess = {
    atom: PrimitiveAtom<Map<StoreKey, any>>
    jotaiStore: any
}

const registry = new WeakMap<IStore<any>, StoreAccess>()

export const registerStoreAccess = (store: IStore<any>, atom: PrimitiveAtom<Map<StoreKey, any>>, jotaiStore: any) => {
    registry.set(store, { atom, jotaiStore })
}

export const resolveStoreAccess = (store: IStore<any> | undefined) => {
    if (!store) return null
    return registry.get(store) ?? null
}
