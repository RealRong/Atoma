import type { Entity, StoreDispatchEvent, StoreHandle } from '../../types'
import type { MutationProgram, MutationProgramKind } from './types'
import { planLocalMutation } from './Plan'
import { translateMutationToWriteOps } from './Ops'
import { resolvePersistModeFromOperations } from './Persist'
import type { EntityId } from '#protocol'

export function compileMutationProgram<T extends Entity>({ handle, operations, currentState, fallbackClientTimeMs }: {
    handle: StoreHandle<T>
    operations: Array<StoreDispatchEvent<T>>
    currentState: Map<EntityId, T>
    fallbackClientTimeMs: number
}): MutationProgram<T> {
    const atom = handle.atom

    const persistMode = resolvePersistModeFromOperations(operations)
    
    const local = planLocalMutation({
        operations,
        currentState
    })

    if (persistMode === 'outbox' && local.hasCreate) {
        throw new Error('[Atoma] server-assigned create cannot be persisted via outbox')
    }

    const translated = translateMutationToWriteOps({
        handle,
        operations,
        optimisticState: local.optimisticState,
        baseState: local.baseState,
        fallbackClientTimeMs,
        persistMode
    })

    const kind: MutationProgramKind = local.hasCreate
        ? 'serverCreate'
        : local.hasPatches
            ? 'patches'
            : (local.writeEvents.length ? 'writes' : (local.changedIds.size ? 'hydrate' : 'noop'))

    const baseProgram = {
        persistMode,
        atom,
        baseState: local.baseState,
        optimisticState: local.optimisticState,
        rollbackState: local.baseState,
        changedIds: local.changedIds,
        patches: local.patches,
        inversePatches: local.inversePatches
    }

    if (kind === 'noop' || kind === 'hydrate') {
        return { kind, ...baseProgram, writeOps: [] }
    }

    return { kind, ...baseProgram, writeOps: translated }
}
