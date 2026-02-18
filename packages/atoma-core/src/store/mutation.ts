import type { PartialWithId } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'

type EntityWithOptionalTimestamps = {
    createdAt?: unknown
}

type MutationTimeOptions = {
    now?: () => number
}

const toObjectRecord = (value: unknown): Record<string, unknown> | null => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

export function create<T>(
    obj: Partial<T>,
    idGenerator?: () => EntityId,
    options?: MutationTimeOptions
): PartialWithId<T> {
    const nowMs = (options?.now ?? Date.now)()
    const base = obj as Partial<T> & { id?: EntityId }
    const hasId = typeof base.id === 'string' && base.id.length > 0

    if (!hasId && typeof idGenerator !== 'function') {
        throw new Error('[Atoma] create: id missing and idGenerator is required')
    }

    return {
        ...obj,
        id: hasId ? base.id : idGenerator!(),
        updatedAt: nowMs,
        createdAt: nowMs
    } as PartialWithId<T>
}

export function merge<T>(
    base: PartialWithId<T>,
    patch: PartialWithId<T>,
    options?: MutationTimeOptions
): PartialWithId<T> {
    const nowMs = (options?.now ?? Date.now)()
    const createdAt = (base as EntityWithOptionalTimestamps).createdAt

    return Object.assign({}, base, patch, {
        updatedAt: nowMs,
        createdAt: typeof createdAt === 'number' ? createdAt : nowMs,
        id: patch.id
    }) as PartialWithId<T>
}

export function putMany<T>(items: PartialWithId<T>[], data: Map<EntityId, T>): Map<EntityId, T> {
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

export function deleteMany<T>(ids: EntityId[], data: Map<EntityId, T>): Map<EntityId, T> {
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

export function reuse<T>(existing: T | undefined, incoming: T): T {
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

export function upsertMany<T extends { id: EntityId }>(
    before: Map<EntityId, T>,
    items: ReadonlyArray<T>
): { after: Map<EntityId, T>; items: T[] } {
    let after = before
    let changed = false

    const output: T[] = new Array(items.length)

    const ensureWritable = () => {
        if (!changed) {
            after = new Map(before)
            changed = true
        }
        return after
    }

    for (let index = 0; index < items.length; index++) {
        const item = items[index]
        const id = item.id
        const existing = before.get(id)
        const preserved = reuse(existing, item)
        output[index] = preserved

        if (existing === preserved) continue

        ensureWritable().set(id, preserved)
    }

    return {
        after,
        items: output
    }
}
