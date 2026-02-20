import type { Entity, StoreChange } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'

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

    return {
        id,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {})
    } as StoreChange<T>
}

export function invertChanges<T extends Entity>(changes: ReadonlyArray<StoreChange<T>>): StoreChange<T>[] {
    return changes.map(change => toChange({
        id: change.id,
        before: change.after,
        after: change.before
    }))
}

export function mergeChanges<T extends Entity>(...groups: ReadonlyArray<ReadonlyArray<StoreChange<T>>>): StoreChange<T>[] {
    const order: EntityId[] = []
    const merged = new Map<EntityId, { before?: T; after?: T }>()

    groups.forEach((group) => {
        group.forEach((change) => {
            const id = change.id
            const current = merged.get(id)
            if (!current) {
                order.push(id)
                merged.set(id, {
                    before: change.before,
                    after: change.after
                })
                return
            }

            current.after = change.after
        })
    })

    const changes: StoreChange<T>[] = []
    order.forEach((id) => {
        const change = merged.get(id)
        if (!change) return
        if (change.before === undefined && change.after === undefined) return
        changes.push(toChange({
            id,
            before: change.before,
            after: change.after
        }))
    })
    return changes
}

export function diffMaps<T extends Entity>(
    before: ReadonlyMap<EntityId, T>,
    after: ReadonlyMap<EntityId, T>
): Readonly<{
    changedIds: ReadonlySet<EntityId>
    changes: ReadonlyArray<StoreChange<T>>
}> {
    const changes: StoreChange<T>[] = []
    const changedIds = new Set<EntityId>()

    before.forEach((beforeValue, id) => {
        if (!after.has(id)) {
            changedIds.add(id)
            changes.push(toChange({ id, before: beforeValue }))
            return
        }

        const afterValue = after.get(id) as T
        if (beforeValue === afterValue) return
        changedIds.add(id)
        changes.push(toChange({ id, before: beforeValue, after: afterValue }))
    })

    after.forEach((afterValue, id) => {
        if (before.has(id)) return
        changedIds.add(id)
        changes.push(toChange({ id, after: afterValue }))
    })

    return { changedIds, changes }
}
