import type {
    Entity,
    StoreChange,
    StoreDelta,
    StoreWritebackEntry,
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import { reuse } from './mutation'
import { mergeChanges, toChange } from './changes'

export function writeback<T extends Entity>(
    before: Map<EntityId, T>,
    entries: ReadonlyArray<StoreWritebackEntry<T>>
): StoreDelta<T> | null {
    if (!entries.length) return null

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

    entries.forEach((entry) => {
        if (!entry) return

        if (entry.action === 'delete') {
            const id = entry.id
            if (!after.has(id)) return
            commitChange(id, after.get(id), undefined)
            return
        }

        if (entry.action !== 'upsert') return
        const item = entry.item
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
