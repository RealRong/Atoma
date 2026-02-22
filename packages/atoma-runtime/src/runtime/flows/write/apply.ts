import type {
    Entity,
    StoreChange,
    WriteManyResult,
} from 'atoma-types/core'
import type { WriteConsistency } from 'atoma-types/runtime'
import { invertChanges, mergeChanges } from 'atoma-core/store'
import type {
    PreparedWrites,
    WriteCommitRequest,
    WriteCommitResult,
} from './contracts'
import { resolvePreparedOutput } from './output'

export type OptimisticState<T extends Entity> = Readonly<{
    byIndex: ReadonlyArray<ReadonlyArray<StoreChange<T>>>
    merged: ReadonlyArray<StoreChange<T>>
}>

export function applyOptimistic<T extends Entity>({
    request,
    consistency
}: {
    request: WriteCommitRequest<T>
    consistency: WriteConsistency
}): OptimisticState<T> {
    if (consistency.commit !== 'optimistic') {
        return {
            byIndex: request.prepared.map(() => []),
            merged: []
        }
    }

    const byIndex = request.prepared.map((item) => {
        const delta = request.scope.handle.state.apply([item.optimistic])
        return delta?.changes ?? []
    })
    return {
        byIndex,
        merged: mergeChanges(...byIndex)
    }
}

export function rollbackOptimistic<T extends Entity>(
    request: WriteCommitRequest<T>,
    optimisticChanges: ReadonlyArray<StoreChange<T>>
) {
    if (!optimisticChanges.length) return
    request.scope.handle.state.apply(invertChanges(optimisticChanges))
}

function buildLocalWriteResult<T extends Entity>(prepared: PreparedWrites<T>): WriteManyResult<T | void> {
    return prepared.map((item, index) => ({
        index,
        ok: true,
        value: resolvePreparedOutput(item, index)
    }))
}

export function applyLocalWrites<T extends Entity>({
    request,
    optimisticChanges
}: {
    request: WriteCommitRequest<T>
    optimisticChanges: ReadonlyArray<StoreChange<T>>
}): WriteCommitResult<T> {
    const { scope, prepared } = request
    const appliedChanges = optimisticChanges.length
        ? optimisticChanges
        : (scope.handle.state.apply(prepared.map((item) => item.optimistic))?.changes ?? [])
    const results = buildLocalWriteResult(prepared)

    return {
        status: 'confirmed',
        changes: mergeChanges(appliedChanges),
        results
    }
}
