import type { Entity } from '../../types'
import type { EntityId } from '#protocol'
import { commitAtomMapUpdateDelta } from './atomMap'
import { preserveReferenceShallow } from './preserveReference'
import { validateWithSchema } from './validation'
import type { StoreHandle } from './handleTypes'

export type WritebackVersionUpdate = {
    key: EntityId
    version: number
}

export type StoreWritebackArgs<T extends Entity> = {
    upserts?: T[]
    deletes?: EntityId[]
    versionUpdates?: WritebackVersionUpdate[]
}

export async function applyStoreWriteback<T extends Entity>(
    handle: StoreHandle<T>,
    args: StoreWritebackArgs<T>
): Promise<void> {
    const upserts = args.upserts ?? []
    const deletes = args.deletes ?? []
    const versionUpdates = args.versionUpdates ?? []

    if (!upserts.length && !deletes.length && !versionUpdates.length) return

    const before = handle.jotaiStore.get(handle.atom)
    let after: Map<EntityId, T> | null = null
    const changedIds = new Set<EntityId>()

    const ensureAfter = () => {
        if (!after) after = new Map(before)
        return after
    }

    const getMap = () => after ?? before

    for (const id of deletes) {
        const mapRef = getMap()
        if (!mapRef.has(id)) continue
        ensureAfter().delete(id)
        changedIds.add(id)
    }

    for (const raw of upserts) {
        const transformed = handle.transform(raw)
        const validated = await validateWithSchema(transformed, handle.schema as any)
        const id = (validated as any).id as EntityId

        const mapRef = getMap()
        const existing = mapRef.get(id)
        const existed = mapRef.has(id)

        const item = existing ? preserveReferenceShallow(existing, validated) : validated
        if (existed && existing === item) continue

        ensureAfter().set(id, item)
        changedIds.add(id)
    }

    if (versionUpdates.length) {
        const versionByKey = new Map<EntityId, number>()
        for (const v of versionUpdates) {
            versionByKey.set(v.key, v.version)
        }

        for (const [key, version] of versionByKey.entries()) {
            const mapRef: any = getMap() as any
            const cur = mapRef.get(key) as any
            if (!cur || typeof cur !== 'object') continue
            if (cur.version === version) continue

            ensureAfter().set(key, { ...cur, version } as any)
            changedIds.add(key)
        }
    }

    if (changedIds.size === 0) return
    if (!after) after = new Map(before)
    const afterMap = after

    for (const id of Array.from(changedIds)) {
        const beforeHas = before.has(id)
        const afterHas = afterMap.has(id)
        if (beforeHas !== afterHas) continue
        if (before.get(id) === afterMap.get(id)) {
            changedIds.delete(id)
        }
    }

    if (changedIds.size === 0) return
    commitAtomMapUpdateDelta({
        handle,
        before,
        after: afterMap,
        changedIds
    })
}
