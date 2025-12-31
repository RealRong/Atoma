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
    options?: { include?: RelationIncludeInput<Relations> & Include }
): (keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]) {
    type Result = keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]

    const handle = Core.store.getHandle(store)
    if (!handle) {
        throw new Error('[Atoma] useAll: 未找到 storeHandle（atom/jotaiStore），请确认 store 已通过 createStore 创建')
    }

    const objectMapAtom = handle.atom
    const jotaiStore = handle.jotaiStore

    const all = useAtomValue(objectMapAtom, { store: jotaiStore })
    const memoedArr = useMemo(() => Array.from(all.values()), [all])

    const relations = handle.relations?.()
    if (!options?.include || !relations) return memoedArr as Result

    const resolveStore = handle.services.resolveStore
    const relationsResult = useRelations<T, Relations, Include>(memoedArr, options.include, relations as Relations, resolveStore)
    return relationsResult.data as unknown as Result
}
