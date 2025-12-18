import type { IStore } from './types'

export const ATOMA_STORE_REF = Symbol.for('atoma:store-ref')

export type AtomaStoreRef = {
    [ATOMA_STORE_REF]: () => IStore<any>
}

export const unwrapStoreRef = (store: IStore<any> | undefined): IStore<any> | undefined => {
    if (!store) return undefined
    const getter = (store as any)?.[ATOMA_STORE_REF]
    if (typeof getter === 'function') {
        try {
            return getter()
        } catch {
            return store
        }
    }
    return store
}

