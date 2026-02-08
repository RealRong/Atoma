import type { Entity, WriteIntent } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { StoreHandle, WritePolicy } from 'atoma-types/runtime'
import { applyIntentsOptimistically } from './applyIntentsOptimistically'
import type { OptimisticState } from '../types'

export function applyOptimisticCommit<T extends Entity>(args: {
    handle: StoreHandle<T>
    intents: Array<WriteIntent<T>>
    writePolicy: WritePolicy
    preserve: (existing: T | undefined, incoming: T) => T
}): OptimisticState<T> {
    const { handle, intents, writePolicy, preserve } = args
    const before = handle.state.getSnapshot() as Map<EntityId, T>
    const shouldOptimistic = writePolicy.optimistic !== false

    const optimistic = (shouldOptimistic && intents.length)
        ? applyIntentsOptimistically(before, intents, preserve)
        : { optimisticState: before, changedIds: new Set<EntityId>() }

    const { optimisticState, changedIds } = optimistic
    if (optimisticState !== before && changedIds.size) {
        handle.state.commit({
            before,
            after: optimisticState,
            changedIds
        })
    }

    return {
        before,
        optimisticState,
        changedIds
    }
}

export function rollbackOptimisticCommit<T extends Entity>(args: {
    handle: StoreHandle<T>
    optimisticState: OptimisticState<T>
}) {
    const { handle, optimisticState } = args
    if (optimisticState.optimisticState !== optimisticState.before && optimisticState.changedIds.size) {
        handle.state.commit({
            before: optimisticState.optimisticState,
            after: optimisticState.before,
            changedIds: optimisticState.changedIds
        })
    }
}
