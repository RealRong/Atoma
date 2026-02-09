import type {
    Entity,
    StoreWritebackArgs,
    StoreWritebackOptions,
    StoreWritebackResult
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { preserveRef } from './mutation'

type VersionedEntity = Entity & {
    version?: unknown
}

export function writeback<T extends Entity>(
    before: Map<EntityId, T>,
    args: StoreWritebackArgs<T>,
    options?: StoreWritebackOptions<T>
): StoreWritebackResult<T> | null {
    const upserts = args.upserts ?? []
    const deletes = args.deletes ?? []
    const versionUpdates = args.versionUpdates ?? []

    if (!upserts.length && !deletes.length && !versionUpdates.length) return null

    const preserve = options?.preserve ?? preserveRef
    let after: Map<EntityId, T> = before
    let changed = false
    const changedIds = new Set<EntityId>()

    const ensureWritable = () => {
        if (!changed) {
            after = new Map(before)
            changed = true
        }
        return after
    }

    for (const id of deletes) {
        if (!after.has(id)) continue
        ensureWritable().delete(id)
        changedIds.add(id)
    }

    for (const item of upserts) {
        if (!item) continue

        const id = item.id
        if (id === undefined || id === null) continue

        const existed = after.has(id)
        const existing = after.get(id)
        const next = existing ? preserve(existing, item) : item
        if (existed && existing === next) continue

        ensureWritable().set(id, next)
        changedIds.add(id)
    }

    if (versionUpdates.length) {
        const versionByKey = new Map<EntityId, number>()
        for (const v of versionUpdates) {
            if (!v) continue
            versionByKey.set(v.key, v.version)
        }

        for (const [key, version] of versionByKey.entries()) {
            const current = after.get(key)
            if (!current || typeof current !== 'object') continue

            const currentVersion = (current as VersionedEntity).version
            if (currentVersion === version) continue

            const next = {
                ...(current as Record<string, unknown>),
                version
            } as unknown as T

            ensureWritable().set(key, next)
            changedIds.add(key)
        }
    }

    if (!changed || changedIds.size === 0) return null

    const nextChangedIds = new Set(changedIds)
    for (const id of Array.from(nextChangedIds)) {
        const beforeHas = before.has(id)
        const afterHas = after.has(id)
        if (beforeHas !== afterHas) continue
        if (before.get(id) === after.get(id)) {
            nextChangedIds.delete(id)
        }
    }

    if (nextChangedIds.size === 0) return null
    return { before, after, changedIds: nextChangedIds }
}
