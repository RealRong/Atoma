import type { Entity, PartialWithId } from '../../types'
import type { EntityId } from '#protocol'
import type { StoreHandle } from './handleTypes'

export type ChangedIds = ReadonlyArray<EntityId> | ReadonlySet<EntityId>

export function clear<T>(data: Map<EntityId, T>): Map<EntityId, T> {
    if (data.size === 0) return data
    return new Map()
}

export function add<T>(item: PartialWithId<T>, data: Map<EntityId, T>): Map<EntityId, T> {
    const id = item.id
    if (data.has(id) && data.get(id) === (item as any)) return data
    const next = new Map(data)
    next.set(id, item as any)
    return next
}

export function bulkAdd<T>(items: PartialWithId<T>[], data: Map<EntityId, T>): Map<EntityId, T> {
    if (!items.length) return data

    let next = data
    let changed = false
    const ensure = () => {
        if (!changed) {
            next = new Map(data)
            changed = true
        }
        return next
    }

    for (const item of items) {
        const id = item.id
        const had = next.has(id)
        const prev = next.get(id)
        if (!had || prev !== (item as any)) {
            ensure().set(id, item as any)
        }
    }

    return next
}

export function bulkRemove<T>(ids: EntityId[], data: Map<EntityId, T>): Map<EntityId, T> {
    if (!ids.length) return data

    let next = data
    let changed = false
    const ensure = () => {
        if (!changed) {
            next = new Map(data)
            changed = true
        }
        return next
    }

    for (const id of ids) {
        if (next.has(id)) {
            ensure().delete(id)
        }
    }

    return next
}

export function remove<T>(id: EntityId, data: Map<EntityId, T>): Map<EntityId, T> {
    if (!data.has(id)) return data
    const next = new Map(data)
    next.delete(id)
    return next
}

export function get<T>(id: EntityId | undefined, data: Map<EntityId, T>): T | undefined {
    if (id !== undefined && id !== null) {
        return data.get(id)
    }
}

export function commitAtomMapUpdate<T extends Entity>(params: {
    handle: StoreHandle<T>
    before: Map<EntityId, T>
    after: Map<EntityId, T>
}) {
    const { handle, before, after } = params
    const { jotaiStore, atom, indexes } = handle

    if (before === after) return

    jotaiStore.set(atom, after)
    indexes?.applyMapDiff(before, after)
}

export function commitAtomMapUpdateDelta<T extends Entity>(params: {
    handle: StoreHandle<T>
    before: Map<EntityId, T>
    after: Map<EntityId, T>
    changedIds: ChangedIds
}) {
    const { handle, before, after, changedIds } = params
    const { jotaiStore, atom, indexes } = handle

    if (before === after) return

    const size = Array.isArray(changedIds)
        ? changedIds.length
        : (changedIds as ReadonlySet<EntityId>).size
    if (size === 0) return

    jotaiStore.set(atom, after)
    indexes?.applyChangedIds(before, after, changedIds)
}
