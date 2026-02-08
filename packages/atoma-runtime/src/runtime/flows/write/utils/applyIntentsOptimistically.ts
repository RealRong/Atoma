import type { Entity, WriteIntent } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'

export function applyIntentsOptimistically<T extends Entity>(
    baseState: Map<EntityId, T>,
    intents: Array<WriteIntent<T>>,
    preserve: (existing: T | undefined, incoming: T) => T
): { afterState: Map<EntityId, T>; changedIds: Set<EntityId> } {
    let nextState = baseState
    const changedIds = new Set<EntityId>()

    const ensureMutableState = () => {
        if (nextState === baseState) {
            nextState = new Map(baseState)
        }
        return nextState
    }

    const upsert = (id: EntityId, value: T) => {
        const currentState = nextState === baseState ? baseState : nextState
        const current = currentState.get(id)
        const preserved = preserve(current, value)
        if (currentState.has(id) && current === preserved) return
        ensureMutableState().set(id, preserved)
        changedIds.add(id)
    }

    const remove = (id: EntityId) => {
        const currentState = nextState === baseState ? baseState : nextState
        if (!currentState.has(id)) return
        ensureMutableState().delete(id)
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

    return { afterState: nextState, changedIds }
}
