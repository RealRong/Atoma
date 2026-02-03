import type * as Types from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { Store } from 'atoma-core'

export function applyIntentsOptimistically<T extends Types.Entity>(
    baseState: Map<EntityId, T>,
    intents: Array<Types.WriteIntent<T>>
): { optimisticState: Map<EntityId, T>; changedIds: Set<EntityId> } {
    let next = baseState
    const changedIds = new Set<EntityId>()

    const ensureNext = () => {
        if (next === baseState) {
            next = new Map(baseState)
        }
        return next
    }

    const upsert = (id: EntityId, value: T) => {
        const mapRef = next === baseState ? baseState : next
        const current = mapRef.get(id)
        const preserved = Store.StoreWriteUtils.preserveReferenceShallow(current, value)
        if (mapRef.has(id) && current === preserved) return
        ensureNext().set(id, preserved)
        changedIds.add(id)
    }

    const remove = (id: EntityId) => {
        const mapRef = next === baseState ? baseState : next
        if (!mapRef.has(id)) return
        ensureNext().delete(id)
        changedIds.add(id)
    }

    for (const intent of intents) {
        const entityId = intent.entityId
        if (!entityId) continue
        if (intent.action === 'delete') {
            remove(entityId as EntityId)
            continue
        }
        if (intent.value !== undefined) {
            upsert(entityId as EntityId, intent.value as T)
        }
    }

    return { optimisticState: next, changedIds }
}
