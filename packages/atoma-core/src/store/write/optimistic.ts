import { applyPatches, type Patch } from 'immer'
import type { Entity } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { StoreWriteUtils } from './utils'
import type { WriteEvent } from './events'

export function buildOptimisticState<T extends Entity>(args: {
    baseState: Map<EntityId, T>
    event: WriteEvent<T>
}): { optimisticState: Map<EntityId, T>; changedIds: Set<EntityId>; output?: T | void } {
    const { baseState, event } = args
    let next: Map<EntityId, T> = baseState
    const changedIds = new Set<EntityId>()

    const ensureNext = () => {
        if (next === baseState) {
            next = new Map(baseState)
        }
        return next
    }

    const upsert = (id: EntityId, value: T) => {
        const current = (next === baseState ? baseState : next).get(id)
        const preserved = StoreWriteUtils.preserveReferenceShallow(current, value)
        if ((next === baseState ? baseState : next).has(id) && current === preserved) return
        ensureNext().set(id, preserved)
        changedIds.add(id)
    }

    const remove = (id: EntityId) => {
        const mapRef = next === baseState ? baseState : next
        if (!mapRef.has(id)) return
        ensureNext().delete(id)
        changedIds.add(id)
    }

    if (event.type === 'add') {
        const id = event.data.id as EntityId
        upsert(id, event.data as any)
        return { optimisticState: next, changedIds, output: event.data as any }
    }

    if (event.type === 'update') {
        const id = event.data.id as EntityId
        upsert(id, event.data as any)
        return { optimisticState: next, changedIds, output: event.data as any }
    }

    if (event.type === 'upsert') {
        const id = event.data.id as EntityId
        upsert(id, event.data as any)
        return { optimisticState: next, changedIds, output: event.data as any }
    }

    if (event.type === 'remove') {
        const id = event.data.id as EntityId
        const origin = baseState.get(id)
        if (origin) {
            const now = Date.now()
            const nextObj = Object.assign({}, origin, { deleted: true, deletedAt: now }) as any
            upsert(id, nextObj)
        }
        return { optimisticState: next, changedIds }
    }

    if (event.type === 'forceRemove') {
        remove(event.data.id as EntityId)
        return { optimisticState: next, changedIds }
    }

    if (event.type === 'patches') {
        const optimisticState = applyPatches(baseState, event.patches) as Map<EntityId, T>
        const patchChanged = new Set<EntityId>()
        collectChangedIdsFromPatches(event.patches, patchChanged)
        return { optimisticState, changedIds: patchChanged }
    }

    return { optimisticState: next, changedIds }
}

export function collectChangedIdsFromPatches(patches: Patch[], changedIds: Set<EntityId>) {
    for (const p of patches) {
        const root = p.path?.[0]
        if (typeof root === 'string' && root) changedIds.add(root as EntityId)
    }
}
