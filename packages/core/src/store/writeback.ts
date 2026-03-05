import type {
    Entity,
    StoreChange,
    StoreWritebackEntry,
} from '@atoma-js/types/core'
import type { EntityId } from '@atoma-js/types/shared'
import { reuse } from './mutation'
import { mergeChanges, toChange } from './changes'

type WritebackResult<T extends Entity> = Readonly<{
    after: Map<EntityId, T>
    changes: ReadonlyArray<StoreChange<T>>
}>

export function writeback<T extends Entity>(
    before: Map<EntityId, T>,
    entries: ReadonlyArray<StoreWritebackEntry<T>>
): WritebackResult<T> {
    if (!entries.length) {
        return {
            after: before,
            changes: []
        }
    }

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
    return {
        after,
        changes
    }
}
