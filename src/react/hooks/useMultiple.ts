import { useAtomValue } from 'jotai'
import { useMemo } from 'react'
import { Core } from '#core'
import type { Entity, IStore, RelationIncludeInput, StoreKey, WithRelations } from '#core'
import { useRelations } from './useRelations'

interface UseMultipleOptions<T, Relations = {}> {
    limit?: number
    unique?: boolean
    selector?: (item: T) => any
    include?: RelationIncludeInput<Relations>
}

export function useMultiple<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: IStore<T, Relations>,
    ids: StoreKey[] = [],
    options?: UseMultipleOptions<T, Relations> & { include?: Include }
): (keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]) {
    type Result = keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]

    const handle = Core.store.getHandle(store)
    if (!handle) {
        throw new Error('[Atoma] useMultiple: 未找到 storeHandle（atom/jotaiStore），请确认 store 已通过 createCoreStore/createStore 创建')
    }

    const objectMapAtom = handle.atom
    const jotaiStore = handle.jotaiStore

    const map = useAtomValue(objectMapAtom, { store: jotaiStore })
    const { limit, unique = true, selector, include } = options || {}

    const baseList = useMemo(() => {
        const seen = new Set<StoreKey>()
        const arr: T[] = []
        ids.forEach(id => {
            if (unique && seen.has(id)) return
            const item = map.get(id)
            if (item) {
                seen.add(id)
                arr.push(item)
            }
        })

        return limit !== undefined ? arr.slice(0, limit) : arr
    }, [ids, map, limit, unique])

    const relations = handle.relations?.() as Relations | undefined
    const resolveStore = handle.services.resolveStore
    const effectiveInclude = (include ?? ({} as Include))
    const relationsResult = useRelations<T, Relations, Include>(baseList, effectiveInclude, relations, resolveStore)
    const withRelations = relationsResult.data

    return useMemo(() => {
        if (!selector) return withRelations as unknown as Result
        return withRelations.map(selector) as unknown as Result
    }, [withRelations, selector]) as Result
}
