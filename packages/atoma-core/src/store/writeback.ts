import type {
    Entity,
    StoreChange,
    StoreDelta,
    StoreWritebackArgs,
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
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
    let after = before
    let writable = false
    const changesById = new Map<EntityId, { before?: T; after?: T }>()
    const ensureWritable = (): Map<EntityId, T> => {
        if (!writable) {
            after = new Map(before)
            writable = true
        }
        return after
    }
    const markBefore = (id: EntityId, value: T | undefined) => {
        if (changesById.has(id)) return
        changesById.set(id, { before: value })
    }
    const markAfter = (id: EntityId, value: T | undefined) => {
        const entry = changesById.get(id)
        if (entry) {
            entry.after = value
            return
        }
        changesById.set(id, { after: value })
    }

    deletes.forEach((id) => {
        if (!after.has(id)) return
        markBefore(id, after.get(id))
        ensureWritable().delete(id)
        changedIds.add(id)
        markAfter(id, undefined)
    })

    upserts.forEach((item) => {
        if (!item) return
        const id = item.id
        if (id === undefined || id === null) return

        const existing = after.get(id)
        const next = existing
            ? preserveRef(existing as T, item)
            : item
        if (after.has(id) && existing === next) return

        markBefore(id, existing)
        ensureWritable().set(id, next)
        changedIds.add(id)
        markAfter(id, next)
    })

    versionUpdates.forEach((value) => {
        if (!value) return
        const key = value.key
        const version = value.version
        const current = after.get(key)
        if (!current || typeof current !== 'object') return
        if ((current as VersionedEntity).version === version) return

        const next = {
            ...current,
            version
        } as T
        markBefore(key, current)
        ensureWritable().set(key, next)
        changedIds.add(key)
        markAfter(key, next)
    })

    if (!changedIds.size) return null

    const changes: StoreChange<T>[] = []
    changedIds.forEach((id) => {
        const change = changesById.get(id)
        if (!change) return
        changes.push({
            id,
            ...(change.before !== undefined ? { before: change.before } : {}),
            ...(change.after !== undefined ? { after: change.after } : {})
        })
    })

    return {
        before,
        after,
        changedIds,
        changes
    }
}
