import type { Entity, StoreChange } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import { mergeChanges, toChange } from './changes'

type Reuse<T extends Entity> = (existing: T | undefined, incoming: T) => T

export type StateChangesResult<T extends Entity> = Readonly<{
    after: Map<EntityId, T>
    changes: ReadonlyArray<StoreChange<T>>
}>

export function applyChanges<T extends Entity>({
    before,
    changes,
    reuse
}: {
    before: Map<EntityId, T>
    changes: ReadonlyArray<StoreChange<T>>
    reuse: Reuse<T>
}): StateChangesResult<T> {
    if (!changes.length) {
        return {
            after: before,
            changes: []
        }
    }

    const source = mergeChanges(changes)
    if (!source.length) {
        return {
            after: before,
            changes: []
        }
    }

    let after = before
    let writable = false
    const ensureWritable = (): Map<EntityId, T> => {
        if (!writable) {
            after = new Map(before)
            writable = true
        }
        return after
    }

    const normalized: StoreChange<T>[] = []

    for (const change of source) {
        const id = change.id
        const previous = before.get(id)
        const target = change.after
        if (target === undefined) {
            if (previous === undefined) continue
            ensureWritable().delete(id)
            normalized.push(toChange({
                id,
                before: previous
            }))
            continue
        }

        const preserved = reuse(previous, target)
        if (previous === preserved) continue
        ensureWritable().set(id, preserved)
        if (previous === undefined) {
            normalized.push(toChange({
                id,
                after: preserved
            }))
            continue
        }
        normalized.push(toChange({
            id,
            before: previous,
            after: preserved
        }))
    }

    return {
        after,
        changes: normalized
    }
}

export function upsertChanges<T extends Entity>({
    before,
    items,
    reuse
}: {
    before: Map<EntityId, T>
    items: ReadonlyArray<T>
    reuse: Reuse<T>
}): StateChangesResult<T> {
    if (!items.length) {
        return {
            after: before,
            changes: []
        }
    }

    let after = before
    let writable = false
    const ensureWritable = (): Map<EntityId, T> => {
        if (!writable) {
            after = new Map(before)
            writable = true
        }
        return after
    }

    const rawChanges: StoreChange<T>[] = []
    const seenIds = items.length > 1 ? new Set<EntityId>() : null
    let hasDuplicateId = false

    for (const item of items) {
        const id = item.id
        if (seenIds) {
            if (seenIds.has(id)) {
                hasDuplicateId = true
            } else {
                seenIds.add(id)
            }
        }

        const current = after.get(id)
        const hasCurrent = current !== undefined || after.has(id)
        const next = hasCurrent
            ? reuse(current, item)
            : item
        if (hasCurrent && current === next) continue
        ensureWritable().set(id, next)
        rawChanges.push(toChange({
            id,
            before: current,
            after: next
        }))
    }

    return {
        after,
        changes: hasDuplicateId
            ? mergeChanges(rawChanges)
            : rawChanges
    }
}

export function replaceChanges<T extends Entity>({
    before,
    items,
    reuse
}: {
    before: Map<EntityId, T>
    items: ReadonlyArray<T>
    reuse: Reuse<T>
}): StateChangesResult<T> {
    const incomingIds = new Set<EntityId>()
    items.forEach((item) => {
        incomingIds.add(item.id)
    })

    let after = before
    let writable = false
    const ensureWritable = (): Map<EntityId, T> => {
        if (!writable) {
            after = new Map(before)
            writable = true
        }
        return after
    }

    const order: EntityId[] = []
    const merged = new Map<EntityId, { before?: T; after?: T }>()
    const record = (id: EntityId, current: T | undefined, next: T | undefined) => {
        const existing = merged.get(id)
        if (!existing) {
            order.push(id)
            merged.set(id, { before: current, after: next })
            return
        }
        existing.after = next
    }

    before.forEach((current, id) => {
        if (incomingIds.has(id)) return
        ensureWritable().delete(id)
        record(id, current, undefined)
    })

    items.forEach((item) => {
        const id = item.id
        const current = after.get(id)
        const hasCurrent = current !== undefined || after.has(id)
        const next = hasCurrent
            ? reuse(current, item)
            : item
        if (hasCurrent && current === next) return
        ensureWritable().set(id, next)
        record(id, current, next)
    })

    if (!order.length) {
        return {
            after: before,
            changes: []
        }
    }

    const changes: StoreChange<T>[] = new Array(order.length)
    let cursor = 0
    order.forEach((id) => {
        const change = merged.get(id)
        if (!change) return
        if (change.before === undefined && change.after === undefined) return
        changes[cursor] = toChange({
            id,
            before: change.before,
            after: change.after
        })
        cursor += 1
    })
    return {
        after,
        changes: cursor === changes.length
            ? changes
            : changes.slice(0, cursor)
    }
}
