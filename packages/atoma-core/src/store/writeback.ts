import type {
    Entity,
    StoreChange,
    StoreDelta,
    StoreWritebackArgs,
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import { reuse } from './mutation'
import { mergeChanges, toChange } from './changes'

type VersionedEntity = Entity & {
    version?: unknown
}

export function writeback<T extends Entity>(
    before: Map<EntityId, T>,
    args: StoreWritebackArgs<T>
): StoreDelta<T> | null {
    const { upserts = [], deletes = [], versionUpdates = [] } = args

    if (!upserts.length && !deletes.length && !versionUpdates.length) return null

    let after = before
    let writable = false
    const rawChanges: StoreChange<T>[] = []

    const ensureWritable = (): Map<EntityId, T> => {
        if (!writable) {
            after = new Map(before)
            writable = true
        }
        return after
    }

    const commitChange = (id: EntityId, current: T | undefined, next: T | undefined) => {
        if (next === undefined) {
            ensureWritable().delete(id)
        } else {
            ensureWritable().set(id, next)
        }
        rawChanges.push(toChange({
            id,
            before: current,
            after: next
        }))
    }

    deletes.forEach((id) => {
        if (!after.has(id)) return
        commitChange(id, after.get(id), undefined)
    })

    upserts.forEach((item) => {
        if (!item) return
        const id = item.id
        if (id === undefined || id === null) return

        const existing = after.get(id)
        const next = existing
            ? reuse(existing as T, item)
            : item
        if (after.has(id) && existing === next) return

        commitChange(id, existing, next)
    })

    versionUpdates.forEach((value) => {
        if (!value) return
        const id = value.id
        const version = value.version
        const current = after.get(id)
        if (!current || typeof current !== 'object') return
        if ((current as VersionedEntity).version === version) return

        const next = {
            ...current,
            version
        } as T
        commitChange(id, current, next)
    })

    const changes = mergeChanges(rawChanges)
    if (!changes.length) return null
    const changedIds = new Set<EntityId>()
    changes.forEach(change => {
        changedIds.add(change.id)
    })

    return {
        before,
        after,
        changedIds,
        changes
    }
}
