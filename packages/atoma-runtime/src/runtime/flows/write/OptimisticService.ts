import type { Entity, WriteIntent } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { StoreHandle } from 'atoma-types/runtime'
import { applyIntentsOptimistically } from './optimistic'

export class OptimisticService {
    apply<T extends Entity>(args: {
        handle: StoreHandle<T>
        intents: Array<WriteIntent<T>>
        writePolicy: { optimistic?: boolean }
    }): {
        before: Map<EntityId, T>
        optimisticState: Map<EntityId, T>
        changedIds: Set<EntityId>
    } {
        const { handle, intents, writePolicy } = args
        const before = handle.state.getSnapshot() as Map<EntityId, T>
        const shouldOptimistic = writePolicy.optimistic !== false
        const optimistic = (shouldOptimistic && intents.length)
            ? applyIntentsOptimistically(before, intents)
            : { optimisticState: before, changedIds: new Set<EntityId>() }
        const { optimisticState, changedIds } = optimistic

        if (optimisticState !== before && changedIds.size) {
            handle.state.commit({
                before,
                after: optimisticState,
                changedIds
            })
        }

        return { before, optimisticState, changedIds }
    }

    rollback<T extends Entity>(args: {
        handle: StoreHandle<T>
        before: Map<EntityId, T>
        optimisticState: Map<EntityId, T>
        changedIds: Set<EntityId>
    }) {
        if (args.optimisticState !== args.before && args.changedIds.size) {
            args.handle.state.commit({
                before: args.optimisticState,
                after: args.before,
                changedIds: args.changedIds
            })
        }
    }
}
