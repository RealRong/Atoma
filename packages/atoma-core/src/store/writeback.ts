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
        const target = ensureWritable()
        if (next === undefined) {
            target.delete(id)
        } else {
            target.set(id, next)
        }
        rawChanges.push(toChange({
            id,
            before: current,
            after: next
        }))
    }

    entries.forEach((entry) => {
        switch (entry.action) {
            case 'delete': {
                const id = entry.id
                const current = after.get(id)
                if (current === undefined && !after.has(id)) return
                commitChange(id, current, undefined)
                return
            }
            case 'upsert': {
                const item = entry.item
                const id = item.id
                const current = after.get(id)
                const hasCurrent = current !== undefined || after.has(id)
                const next = hasCurrent
                    ? reuse(current, item)
                    : item
                if (hasCurrent && current === next) return

                commitChange(id, current, next)
                return
            }
        }
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
