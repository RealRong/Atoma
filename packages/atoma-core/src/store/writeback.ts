import { produceWithPatches, type Draft } from 'immer'
import type {
    Entity,
    StoreDelta,
    StoreWritebackArgs,
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { preserveRef } from './mutation'

type VersionedEntity = Entity & {
    version?: unknown
}

export function writeback<T extends Entity>(
    before: Map<EntityId, T>,
    args: StoreWritebackArgs<T>
): StoreDelta<T> | null {
    const upserts = args.upserts ?? []
    const deletes = args.deletes ?? []
    const versionUpdates = args.versionUpdates ?? []

    if (!upserts.length && !deletes.length && !versionUpdates.length) return null

    const changedIds = new Set<EntityId>()
    const versionByKey = new Map<EntityId, number>()
    versionUpdates.forEach((value) => {
        if (!value) return
        versionByKey.set(value.key, value.version)
    })
    const [after, patches, inversePatches] = produceWithPatches(
        before,
        (draft) => {
            deletes.forEach((id) => {
                if (!draft.has(id)) return
                draft.delete(id)
                changedIds.add(id)
            })

            upserts.forEach((item) => {
                if (!item) return
                const id = item.id
                if (id === undefined || id === null) return

                const existing = draft.get(id)
                const next = existing
                    ? preserveRef(existing as unknown as T, item)
                    : item
                if (draft.has(id) && existing === next) return

                draft.set(id, next as Draft<T>)
                changedIds.add(id)
            })

            versionByKey.forEach((version, key) => {
                const current = draft.get(key)
                if (!current || typeof current !== 'object') return

                if ((current as VersionedEntity).version === version) return
                draft.set(key, {
                    ...current,
                    version
                })
                changedIds.add(key)
            })
        }
    )

    if (!changedIds.size || (!patches.length && !inversePatches.length)) return null

    return {
        before,
        after,
        changedIds,
        patches,
        inversePatches
    }
}
