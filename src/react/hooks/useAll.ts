import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { Core } from '#core'
import type { Entity, IStore, StoreKey, WithRelations, RelationIncludeInput } from '#core'
import { useRelations } from './useRelations'

/**
 * React hook to subscribe to entire collection
 * Returns all items as an array
 */
export function useAll<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: IStore<T, Relations>,
    options?: { include?: Include }
): (keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]) {
    const handle = Core.store.getHandle(store)
    if (!handle) {
        throw new Error('[Atoma] useAll: 未找到 storeHandle（atom/jotaiStore），请确认 store 已通过 createCoreStore/createStore 创建')
    }

    const objectMapAtom = handle.atom
    const jotaiStore = handle.jotaiStore

    const all = useAtomValue(objectMapAtom, { store: jotaiStore })
    const memoedArr = useMemo(() => Array.from(all.values()), [all])

    const relations = handle.relations?.()
    if (!options?.include || !relations) return memoedArr as any

    const resolveStore = handle.services.resolveStore
    const relationsResult = useRelations(memoedArr, options.include as any, relations, resolveStore)
    return relationsResult.data as any
}
