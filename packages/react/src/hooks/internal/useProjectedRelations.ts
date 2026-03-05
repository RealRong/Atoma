import type { Entity, RelationIncludeInput, Store, WithRelations } from '@atoma-js/types/core'
import { getStoreBindings } from '@atoma-js/types/internal'
import { useRelations, type UseRelationsResult } from '../useRelations'

type UseProjectedRelationsArgs<T extends Entity, Relations, Include extends RelationIncludeInput<Relations>> = Readonly<{
    store: Store<T, Relations>
    items: T[]
    include?: Include
    tag: string
}>

export function useProjectedRelations<
    T extends Entity,
    Relations = {},
    const Include extends RelationIncludeInput<Relations> = {}
>(
    args: UseProjectedRelationsArgs<T, Relations, Include>
): UseRelationsResult<keyof Include extends never ? T : WithRelations<T, Relations, Include>> {
    const bindings = getStoreBindings(args.store, args.tag)
    const include = (args.include ?? {}) as Include

    return useRelations<T, Relations, Include>(
        args.items,
        include,
        bindings.relations?.(),
        bindings.useStore
    )
}
