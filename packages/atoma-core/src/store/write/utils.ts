import type { PartialWithId } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { defaultSnowflakeGenerator } from '../idGenerator'

type EntityWithOptionalTimestamps = {
    createdAt?: unknown
}

const toObjectRecord = (value: unknown): Record<string, unknown> | null => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

export function initBaseObject<T>(obj: Partial<T>, idGenerator?: () => EntityId): PartialWithId<T> {
    const generator = idGenerator || defaultSnowflakeGenerator
    const now = Date.now()
    const base = obj as Partial<T> & { id?: EntityId }

    return {
        ...obj,
        id: base.id || generator(),
        updatedAt: now,
        createdAt: now
    } as PartialWithId<T>
}

export function mergeForUpdate<T>(base: PartialWithId<T>, patch: PartialWithId<T>): PartialWithId<T> {
    const createdAt = (base as EntityWithOptionalTimestamps).createdAt

    return Object.assign({}, base, patch, {
        updatedAt: Date.now(),
        createdAt: typeof createdAt === 'number' ? createdAt : Date.now(),
        id: patch.id
    }) as PartialWithId<T>
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
        const nextItem = item as unknown as T

        if (!had || prev !== nextItem) {
            ensure().set(id, nextItem)
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

export function preserveReferenceShallow<T>(existing: T | undefined, incoming: T): T {
    if (existing === undefined || existing === null) return incoming
    if (existing === incoming) return existing

    const left = toObjectRecord(existing)
    const right = toObjectRecord(incoming)
    if (!left || !right) return incoming

    for (const key in left) {
        if (!Object.prototype.hasOwnProperty.call(left, key)) continue
        if (left[key] !== right[key]) return incoming
    }

    for (const key in right) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) continue
        if (right[key] !== left[key]) return incoming
    }

    return existing
}
