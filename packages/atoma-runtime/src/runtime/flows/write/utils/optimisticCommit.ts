import type { Entity, WriteIntent } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { StoreHandle, WritePolicy } from 'atoma-types/runtime'
import { applyIntentsOptimistically } from './applyIntentsOptimistically'
import type { OptimisticState } from '../types'

export function applyOptimisticState<T extends Entity>(args: {
    handle: StoreHandle<T>
    intents: Array<WriteIntent<T>>
    writePolicy: WritePolicy
    preserve: (existing: T | undefined, incoming: T) => T
}): OptimisticState<T> {
    const { handle, intents, writePolicy, preserve } = args
    const beforeState = handle.state.getSnapshot() as Map<EntityId, T>
    const shouldOptimistic = writePolicy.optimistic !== false

    const optimistic = (shouldOptimistic && intents.length)
        ? applyIntentsOptimistically(beforeState, intents, preserve)
        : { afterState: beforeState, changedIds: new Set<EntityId>() }

    const { afterState, changedIds } = optimistic
    if (afterState !== beforeState && changedIds.size) {
        handle.state.commit({
            before: beforeState,
            after: afterState,
            changedIds
        })
    }

    return {
        beforeState,
        afterState,
        changedIds
    }
}

export function rollbackOptimisticState<T extends Entity>(args: {
    handle: StoreHandle<T>
    optimisticState: OptimisticState<T>
}) {
    const { handle, optimisticState } = args
    if (optimisticState.afterState !== optimisticState.beforeState && optimisticState.changedIds.size) {
        handle.state.commit({
            before: optimisticState.afterState,
            after: optimisticState.beforeState,
            changedIds: optimisticState.changedIds
        })
    }
}
