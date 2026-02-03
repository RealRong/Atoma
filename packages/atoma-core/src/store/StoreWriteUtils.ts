import type { Entity, PartialWithId } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { defaultSnowflakeGenerator } from './idGenerator'

export class StoreWriteUtils {
    static initBaseObject<T>(obj: Partial<T>, idGenerator?: () => EntityId): PartialWithId<T> {
        const generator = idGenerator || defaultSnowflakeGenerator
        const now = Date.now()
        return {
            ...(obj as any),
            id: (obj as any).id || generator(),
            updatedAt: now,
            createdAt: now
        } as PartialWithId<T>
    }

    static mergeForUpdate<T>(base: PartialWithId<T>, patch: PartialWithId<T>): PartialWithId<T> {
        return Object.assign({}, base, patch, {
            updatedAt: Date.now(),
            createdAt: (base as any).createdAt ?? Date.now(),
            id: patch.id
        }) as PartialWithId<T>
    }

    static bulkAdd<T>(items: PartialWithId<T>[], data: Map<EntityId, T>): Map<EntityId, T> {
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

    static bulkRemove<T>(ids: EntityId[], data: Map<EntityId, T>): Map<EntityId, T> {
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

    static preserveReferenceShallow<T>(existing: T | undefined, incoming: T): T {
        if (existing === undefined || existing === null) return incoming
        if (existing === incoming) return existing

        if (typeof existing !== 'object' || existing === null) return incoming
        if (typeof incoming !== 'object' || incoming === null) return incoming
        if (Array.isArray(existing) || Array.isArray(incoming)) return incoming

        const a = existing as any
        const b = incoming as any

        for (const k in a) {
            if (!Object.prototype.hasOwnProperty.call(a, k)) continue
            if (a[k] !== b[k]) return incoming
        }
        for (const k in b) {
            if (!Object.prototype.hasOwnProperty.call(b, k)) continue
            if (b[k] !== a[k]) return incoming
        }

        return existing
    }
}