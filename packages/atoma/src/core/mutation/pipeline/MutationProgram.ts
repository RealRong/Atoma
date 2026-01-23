/**
 * Mutation Pipeline: Program Compiler
 * Purpose: Compiles a local mutation plan into an executable program and write operations.
 * Call chain: executeMutationFlow -> buildMutationProgram -> buildLocalMutationPlan -> buildWriteIntentsFromEvents/buildWriteIntentsFromPatches -> translateWriteIntentsToOps.
 */
import type { Entity, StoreDispatchEvent } from '../../types'
import type { MutationProgram, MutationProgramKind } from './types'
import { buildLocalMutationPlan } from './LocalPlan'
import { translateWriteIntentsToOps } from './WriteOps'
import { deriveWriteStrategyFromOperations } from './Persist'
import type { EntityId } from '#protocol'
import type { StoreHandle } from '../../store/internals/handleTypes'

export function buildMutationProgram<T extends Entity>({ handle, operations, currentState, fallbackClientTimeMs }: {
    handle: StoreHandle<T>
    operations: Array<StoreDispatchEvent<T>>
    currentState: Map<EntityId, T>
    fallbackClientTimeMs: number
}): MutationProgram<T> {
    const atom = handle.atom

    const writeStrategy = deriveWriteStrategyFromOperations(operations)
    
    const plan = buildLocalMutationPlan({
        operations,
        currentState,
        fallbackClientTimeMs
    })

    const writeOps = plan.writeIntents.length
        ? translateWriteIntentsToOps({ handle, intents: plan.writeIntents })
        : []

    const kind: MutationProgramKind = plan.hasCreate
        ? 'serverAssignedCreate'
        : plan.hasPatches
            ? 'patches'
            : (plan.writeEvents.length ? 'writes' : (plan.changedIds.size ? 'hydrate' : 'noop'))

    const baseProgram = {
        writeStrategy,
        atom,
        baseState: plan.baseState,
        optimisticState: plan.optimisticState,
        rollbackState: plan.baseState,
        changedIds: plan.changedIds,
        writeIntents: plan.writeIntents,
        patches: plan.patches,
        inversePatches: plan.inversePatches
    }

    if (kind === 'noop' || kind === 'hydrate') {
        return { kind, ...baseProgram, writeIntents: [], writeOps: [] }
    }

    return { kind, ...baseProgram, writeOps }
}
