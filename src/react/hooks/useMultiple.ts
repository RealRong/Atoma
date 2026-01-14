import { atom, useAtomValue } from 'jotai'
import { selectAtom } from 'jotai/utils'
import { useMemo } from 'react'
import { Core } from '#core'
import type { Entity, RelationIncludeInput, StoreHandleOwner, WithRelations } from '#core'
import { useRelations } from './useRelations'
import { useShallowStableArray } from './useShallowStableArray'

interface UseMultipleOptions<T, Relations = {}> {
    limit?: number
    unique?: boolean
    selector?: (item: T) => any
    include?: RelationIncludeInput<Relations>
}

export function useMany<T extends Entity, Relations = {}, const Include extends RelationIncludeInput<Relations> = {}>(
    store: StoreHandleOwner<T, Relations>,
    ids: Array<T['id']> = [],
    options?: UseMultipleOptions<T, Relations> & { include?: Include }
): (keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]) {
    type Result = keyof Include extends never ? T[] : WithRelations<T, Relations, Include>[]

    const handle = Core.store.getHandle(store)
    if (!handle) {
        throw new Error('[Atoma] useMany: 未找到 storeHandle（atom/jotaiStore），请确认 store 已通过 createStore 创建')
    }

    const objectMapAtom = handle.atom
    const jotaiStore = handle.jotaiStore

    const { limit, unique = true, selector, include } = options || {}

    const stableIds = useShallowStableArray(ids)

    const baseListAtom = useMemo(() => {
        if (!stableIds.length) return atom([] as T[])

        const idsSnapshot = stableIds.slice()

        const selectList = (map: Map<T['id'], T>): T[] => {
            const seen = new Set<T['id']>()
            const arr: T[] = []

            for (const id of idsSnapshot) {
                if (unique && seen.has(id)) continue
                const item = map.get(id)
                if (!item) continue

                seen.add(id)
                arr.push(item)

                if (limit !== undefined && arr.length >= limit) break
            }

            return arr
        }

        const shallowEqual = (a: T[], b: T[]) => {
            if (a === b) return true
            if (a.length !== b.length) return false
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) return false
            }
            return true
        }

        return selectAtom(objectMapAtom, selectList, shallowEqual)
    }, [objectMapAtom, stableIds, limit, unique])

    const baseList = useAtomValue(baseListAtom, { store: jotaiStore })

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
