import type { Entity } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'

export function mergeSnapshotValues<T extends Entity>(args: {
    items: T[]
    snapshot: Map<EntityId, Record<string, unknown>>
    getEntityId: (item: unknown) => EntityId | undefined
}): T[] {
    const { items, snapshot, getEntityId } = args
    if (snapshot.size === 0) return items

    return items.map((item) => {
        const id = getEntityId(item)
        if (!id) return item
        const cached = snapshot.get(id)
        if (!cached) return item
        return { ...item, ...cached } as T
    })
}

export function buildSnapshotValues<T extends Entity>(args: {
    items: T[]
    relationNames: string[]
    getEntityId: (item: unknown) => EntityId | undefined
}): Map<EntityId, Record<string, unknown>> {
    const { items, relationNames, getEntityId } = args
    const next = new Map<EntityId, Record<string, unknown>>()

    items.forEach((item) => {
        const id = getEntityId(item)
        if (!id) return

        const record = item as unknown as Record<string, unknown>
        const values: Record<string, unknown> = {}
        relationNames.forEach((name) => {
            values[name] = record[name]
        })
        next.set(id, values)
    })

    return next
}
