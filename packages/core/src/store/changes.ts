import type { Entity, StoreChange } from '@atoma-js/types/core'
import type { EntityId } from '@atoma-js/types/shared'

export function toChange<T extends Entity>({
    id,
    before,
    after
}: {
    id: EntityId
    before?: T
    after?: T
}): StoreChange<T> {
    if (before === undefined && after === undefined) {
        throw new Error(`[Atoma] toChange: missing before/after (id=${String(id)})`)
    }

    if (before === undefined) {
        if (after === undefined) {
            throw new Error(`[Atoma] toChange: missing after (id=${String(id)})`)
        }
        return { id, after }
    }
    if (after === undefined) {
        return { id, before }
    }
    return { id, before, after }
}

export function invertChanges<T extends Entity>(changes: ReadonlyArray<StoreChange<T>>): StoreChange<T>[] {
    return changes.map(change => toChange({
        id: change.id,
        before: change.after,
        after: change.before
    }))
}

export function revertChanges<T extends Entity>(changes: ReadonlyArray<StoreChange<T>>): StoreChange<T>[] {
    const reverted: StoreChange<T>[] = new Array(changes.length)
    for (let source = changes.length - 1, target = 0; source >= 0; source -= 1, target += 1) {
        const change = changes[source]
        reverted[target] = toChange({
            id: change.id,
            before: change.after,
            after: change.before
        })
    }
    return reverted
}

export function mergeChanges<T extends Entity>(...groups: ReadonlyArray<ReadonlyArray<StoreChange<T>>>): ReadonlyArray<StoreChange<T>> {
    if (!groups.length) return []
    let totalLength = 0
    for (const group of groups) {
        totalLength += group.length
    }
    if (!totalLength) return []
    if (totalLength === 1) {
        for (const group of groups) {
            if (group.length === 1) return [group[0]]
        }
    }

    const flattened: StoreChange<T>[] = new Array(totalLength)
    const seenIds = new Set<EntityId>()
    let flattenedCursor = 0
    let mergedCursor = 0
    let order: EntityId[] | undefined
    let merged: Map<EntityId, { before?: T; after?: T }> | undefined
    const mergeOne = (
        map: Map<EntityId, { before?: T; after?: T }>,
        ids: EntityId[],
        change: StoreChange<T>
    ) => {
        const current = map.get(change.id)
        if (!current) {
            ids.push(change.id)
            map.set(change.id, {
                before: change.before,
                after: change.after
            })
            return
        }
        current.after = change.after
    }

    for (const group of groups) {
        for (const change of group) {
            if (merged) {
                if (order) {
                    mergeOne(merged, order, change)
                }
                continue
            }

            flattened[flattenedCursor] = change
            flattenedCursor += 1
            const id = change.id
            if (!seenIds.has(id)) {
                seenIds.add(id)
                continue
            }

            order = []
            merged = new Map<EntityId, { before?: T; after?: T }>()
            while (mergedCursor < flattenedCursor) {
                const seeded = flattened[mergedCursor]
                if (seeded) {
                    mergeOne(merged, order, seeded)
                }
                mergedCursor += 1
            }
        }
    }

    if (!merged) return flattened
    if (!order?.length) return []

    const changes: StoreChange<T>[] = new Array(order.length)
    let cursor = 0
    for (const id of order) {
        const change = merged.get(id)
        if (!change) continue
        if (change.before === undefined && change.after === undefined) continue
        changes[cursor] = toChange({
            id,
            before: change.before,
            after: change.after
        })
        cursor += 1
    }
    return cursor === changes.length
        ? changes
        : changes.slice(0, cursor)
}
