import type { PrimitiveAtom } from 'jotai'
import type { StoreKey } from '../types'
import type { IndexManager } from './IndexManager'

export class IndexRegistry {
    private registry = new Map<PrimitiveAtom<Map<StoreKey, any>>, IndexManager<any>>()

    register<T>(atom: PrimitiveAtom<Map<StoreKey, T>>, indexManager: IndexManager<T>) {
        this.registry.set(atom as any, indexManager as any)
    }

    get<T>(atom: PrimitiveAtom<Map<StoreKey, T>>): IndexManager<T> | undefined {
        return this.registry.get(atom as any)
    }

    unregister(atom: PrimitiveAtom<Map<StoreKey, any>>) {
        this.registry.delete(atom)
    }
}

export const globalIndexRegistry = new IndexRegistry()
