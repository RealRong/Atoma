import type { PartialWithId, StoreKey } from '../../types'

export function clear<T>(data: Map<StoreKey, T>): Map<StoreKey, T> {
    if (data.size === 0) return data
    return new Map()
}

export function add<T>(item: PartialWithId<T>, data: Map<StoreKey, T>): Map<StoreKey, T> {
    const id = item.id
    if (data.has(id) && data.get(id) === (item as any)) return data
    const next = new Map(data)
    next.set(id, item as any)
    return next
}

export function bulkAdd<T>(items: PartialWithId<T>[], data: Map<StoreKey, T>): Map<StoreKey, T> {
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

export function bulkRemove<T>(ids: StoreKey[], data: Map<StoreKey, T>): Map<StoreKey, T> {
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

export function remove<T>(id: StoreKey, data: Map<StoreKey, T>): Map<StoreKey, T> {
    if (!data.has(id)) return data
    const next = new Map(data)
    next.delete(id)
    return next
}

export function get<T>(id: StoreKey | undefined, data: Map<StoreKey, T>): T | undefined {
    if (id !== undefined && id !== null) {
        return data.get(id)
    }
}
