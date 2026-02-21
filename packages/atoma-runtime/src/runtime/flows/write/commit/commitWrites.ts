import type {
    Entity,
    StoreChange,
    WriteManyResult,
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type {
    WriteConsistency
} from 'atoma-types/runtime'
import { invertChanges, mergeChanges } from 'atoma-core/store'
import type {
    PreparedWrites,
    WriteCommitRequest,
    WriteCommitResult,
} from '../types'
import { commitRemoteWrite } from './commitRemoteWrite'
import { reconcileWriteResult } from './reconcileWriteResult'

function applyOptimistic<T extends Entity>({
    request,
    consistency
}: {
    request: WriteCommitRequest<T>
    consistency: WriteConsistency
}): ReadonlyArray<StoreChange<T>> {
    if (request.prepared.length !== 1) return []
    if (consistency.commit !== 'optimistic') return []
    const first = request.prepared[0]
    if (!first) return []

    const optimistic = request.scope.handle.state.apply([
        first.optimistic
    ])

    return optimistic?.changes ?? []
}

function rollbackOptimistic<T extends Entity>(
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
        value: item.output as T | void
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

function commitLocalWrite<T extends Entity>({
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
        changes: mergeChanges(appliedChanges, versionChanges),
        results
    }
}

export async function commitWrites<T extends Entity>(request: WriteCommitRequest<T>): Promise<WriteCommitResult<T>> {
    const { runtime, scope, prepared } = request
    const entries = prepared.map((item) => item.entry)

    if (!entries.length) {
        return {
            changes: [],
            results: []
        }
    }

    const consistency = runtime.execution.resolveConsistency(
        scope.handle,
        scope.signal
            ? { signal: scope.signal }
            : undefined
    )
    const optimisticChanges = applyOptimistic({
        request,
        consistency
    })

    if (!runtime.execution.hasExecutor('write')) {
        return commitLocalWrite({
            request,
            optimisticChanges
        })
    }

    try {
        const remote = await commitRemoteWrite({
            runtime,
            request: {
                scope,
                prepared,
                entries
            }
        })
        if (remote.status === 'enqueued') {
            return {
                changes: optimisticChanges,
                results: remote.results
            }
        }

        const reconcile = reconcileWriteResult({
            scope,
            results: remote.results,
            optimisticChanges,
            upserts: remote.upserts,
            versionUpdates: remote.versionUpdates
        })
        if (reconcile.rollbackOptimistic) {
            rollbackOptimistic(request, optimisticChanges)
        }

        return {
            changes: reconcile.changes,
            results: remote.results
        }
    } catch (error) {
        rollbackOptimistic(request, optimisticChanges)
        throw error
    }
}
