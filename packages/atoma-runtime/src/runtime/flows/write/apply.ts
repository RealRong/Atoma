import type {
    Entity,
    StoreChange,
    WriteManyResult,
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
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

function resolvePositiveNumber(value: unknown): number | undefined {
    return (typeof value === 'number' && Number.isFinite(value) && value > 0)
        ? value
        : undefined
}

function buildLocalWriteResult<T extends Entity>(prepared: PreparedWrites<T>): WriteManyResult<T | void> {
    return prepared.map((item, index) => ({
        index,
        ok: true,
        value: resolvePreparedOutput(item, index)
    }))
}

function collectLocalVersionUpdates<T extends Entity>({
    prepared,
    snapshot
}: {
    prepared: PreparedWrites<T>
    snapshot: ReadonlyMap<EntityId, T>
}): Array<{ id: EntityId; version: number }> {
    const versionUpdates: Array<{ id: EntityId; version: number }> = []

    prepared.forEach((item) => {
        const entry = item.entry
        if (entry.action === 'delete') return

        const id = entry.item.id
        if (typeof id !== 'string' || !id) return
        const current = snapshot.get(id)
        const baseVersion = entry.action === 'create'
            ? undefined
            : entry.action === 'upsert'
                ? resolvePositiveNumber(entry.item.expectedVersion)
                : resolvePositiveNumber(entry.item.baseVersion)
        const snapshotVersion = current && typeof current === 'object'
            ? resolvePositiveNumber((current as { version?: unknown }).version)
            : undefined
        const nextVersion = (baseVersion ?? snapshotVersion ?? 0) + 1
        versionUpdates.push({
            id,
            version: nextVersion
        })
    })

    return versionUpdates
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
    const snapshot = scope.handle.state.snapshot()
    const versionUpdates = collectLocalVersionUpdates({
        prepared,
        snapshot
    })
    const versionChanges = versionUpdates.length
        ? (scope.handle.state.writeback({ versionUpdates })?.changes ?? [])
        : []
    const results = buildLocalWriteResult(prepared)

    return {
        status: 'confirmed',
        changes: mergeChanges(appliedChanges, versionChanges),
        results
    }
}
