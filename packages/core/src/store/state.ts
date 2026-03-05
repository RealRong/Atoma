import type { Entity, StoreChange } from '@atoma-js/types/core'
import type { EntityId } from '@atoma-js/types/shared'
import { mergeChanges, toChange } from './changes'
import { reuse } from './mutation'

type StateChangesResult<T extends Entity> = Readonly<{
    after: Map<EntityId, T>
    changes: ReadonlyArray<StoreChange<T>>
}>

type StepChangesResult<T extends Entity> = Readonly<{
    after: Map<EntityId, T>
    changes: ReadonlyArray<StoreChange<T>>
    steps: ReadonlyArray<StoreChange<T> | undefined>
}>

export function apply<T extends Entity>({
    before,
    changes
}: {
    before: Map<EntityId, T>
    changes: ReadonlyArray<StoreChange<T>>
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

export function applySteps<T extends Entity>({
    before,
    changes
}: {
    before: Map<EntityId, T>
    changes: ReadonlyArray<StoreChange<T>>
}): StepChangesResult<T> {
    if (!changes.length) {
        return {
            after: before,
            changes: [],
            steps: []
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

    const steps: Array<StoreChange<T> | undefined> = new Array(changes.length)
    const order: EntityId[] = []
    const merged = new Map<EntityId, { before?: T; after?: T }>()
    const record = (id: EntityId, previous: T | undefined, next: T | undefined) => {
        const current = merged.get(id)
        if (!current) {
            order.push(id)
            merged.set(id, {
                before: previous,
                after: next
            })
            return
        }
        current.after = next
    }

    for (let index = 0; index < changes.length; index += 1) {
        const change = changes[index]
        if (!change) continue
        const id = change.id
        const previous = after.get(id)
        const target = change.after
        if (target === undefined) {
            if (previous === undefined) {
                steps[index] = undefined
                continue
            }
            ensureWritable().delete(id)
            const applied = toChange({
                id,
                before: previous
            })
            steps[index] = applied
            record(id, previous, undefined)
            continue
        }

        const preserved = reuse(previous, target)
        if (previous === preserved) {
            steps[index] = undefined
            continue
        }
        ensureWritable().set(id, preserved)
        const applied = previous === undefined
            ? toChange({
                id,
                after: preserved
            })
            : toChange({
                id,
                before: previous,
                after: preserved
            })
        steps[index] = applied
        record(id, previous, preserved)
    }

    if (!order.length) {
        return {
            after: before,
            changes: [],
            steps
        }
    }

    const resolved: StoreChange<T>[] = new Array(order.length)
    let cursor = 0
    order.forEach((id) => {
        const change = merged.get(id)
        if (!change) return
        if (change.before === undefined && change.after === undefined) return
        resolved[cursor] = toChange({
            id,
            before: change.before,
            after: change.after
        })
        cursor += 1
    })

    return {
        after,
        changes: cursor === resolved.length
            ? resolved
            : resolved.slice(0, cursor),
        steps
    }
}

export function upsert<T extends Entity>({
    before,
    items,
    assumeUnique = false
}: {
    before: Map<EntityId, T>
    items: ReadonlyArray<T>
    assumeUnique?: boolean
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
    let seenIds = !assumeUnique && items.length > 1
        ? new Set<EntityId>()
        : null
    let order: EntityId[] | undefined
    let merged: Map<EntityId, { before?: T; after?: T }> | undefined
    const mergeOne = (
        map: Map<EntityId, { before?: T; after?: T }>,
        ids: EntityId[],
        { id, before: previous, after: next }: StoreChange<T>
    ) => {
        const current = map.get(id)
        if (!current) {
            ids.push(id)
            map.set(id, {
                before: previous,
                after: next
            })
            return
        }
        current.after = next
    }

    for (const item of items) {
        const id = item.id
        if (seenIds !== null) {
            if (seenIds.has(id)) {
                const initialOrder: EntityId[] = []
                const initialMerged = new Map<EntityId, { before?: T; after?: T }>()
                order = initialOrder
                merged = initialMerged
                rawChanges.forEach((change) => {
                    mergeOne(initialMerged, initialOrder, change)
                })
                seenIds = null
            } else {
                seenIds.add(id)
            }
        }

        const current = after.get(id)
        const next = current === undefined
            ? item
            : reuse(current, item)
        if (current === next) continue
        ensureWritable().set(id, next)
        const change = toChange({
            id,
            before: current,
            after: next
        })
        if (merged && order) {
            mergeOne(merged, order, change)
            continue
        }
        rawChanges.push(change)
    }

    if (!merged || !order) {
        return {
            after,
            changes: rawChanges
        }
    }

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

export function replace<T extends Entity>({
    before,
    items
}: {
    before: Map<EntityId, T>
    items: ReadonlyArray<T>
}): StateChangesResult<T> {
    const incomingOrder: EntityId[] = []
    const incoming = new Map<EntityId, { before?: T; after: T; dirty: boolean }>()
    for (const item of items) {
        const id = item.id
        const existing = incoming.get(id)
        if (!existing) {
            const current = before.get(id)
            const next = current === undefined
                ? item
                : reuse(current, item)
            incomingOrder.push(id)
            incoming.set(id, {
                before: current,
                after: next,
                dirty: current !== next
            })
            continue
        }
        const next = reuse(existing.after, item)
        if (existing.after !== next) {
            existing.dirty = true
        }
        existing.after = next
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

    before.forEach((current, id) => {
        if (incoming.has(id)) return
        ensureWritable().delete(id)
        rawChanges.push(toChange({
            id,
            before: current
        }))
    })

    incomingOrder.forEach((id) => {
        const current = incoming.get(id)
        if (!current?.dirty) return
        ensureWritable().set(id, current.after)
        rawChanges.push(toChange({
            id,
            before: current.before,
            after: current.after
        }))
    })

    if (!rawChanges.length) {
        return {
            after: before,
            changes: []
        }
    }

    return {
        after,
        changes: rawChanges
    }
}
