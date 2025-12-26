import { atom } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { Core } from '#core'
import type { IStore, StoreKey, Entity, WithRelations, RelationIncludeInput } from '#core'
import { useRelations } from './useRelations'

/**
 * React hook to subscribe to a single entity by ID
 * Uses selectAtom for fine-grained updates - only re-renders when this specific item changes
 */
export function useValue<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: IStore<T, Relations>,
    id?: StoreKey,
    options?: { include?: Include }
): (keyof Include extends never ? T | undefined : WithRelations<T, Relations, Include> | undefined) {
    const handle = Core.store.getHandle(store)
    if (!handle) {
        throw new Error('[Atoma] useValue: 未找到 storeHandle（atom/jotaiStore），请确认 store 已通过 createCoreStore/createStore 创建')
    }

    const objectMapAtom = handle.atom
    const jotaiStore = handle.jotaiStore

    const selectedAtom = useMemo(() => {
        if (!id) return atom(undefined)

        const exists = jotaiStore.get(objectMapAtom).has(id)
        if (!exists) {
            store.getOneById(id)
        }

        return selectAtom(objectMapAtom, map => map.get(id))
    }, [id, jotaiStore, objectMapAtom, store])

    const base = useAtomValue(selectedAtom, { store: jotaiStore })
    const relations = handle.relations?.()
    if (!options?.include || !relations) return base as any

    const resolveStore = handle.services.resolveStore
    const rel = useRelations(base ? [base] : [], options.include as any, relations, resolveStore)
    return rel.data[0] as any
}
