import type {
    Entity,
    StoreChange,
    WriteManyItemErr,
    WriteManyResult,
} from 'atoma-types/core'
import type { EntityId } from 'atoma-types/shared'
import type {
    ExecutionOptions,
    Runtime,
    WriteConsistency,
    WriteEntry,
    WriteItemResult,
    WriteOutput
} from 'atoma-types/runtime'
import { invertChanges, mergeChanges } from 'atoma-core/store'
import type {
    PreparedWrite,
    PreparedWrites,
    WriteCommitRequest,
    WriteCommitResult,
    WriteScope
} from '../types'
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

function resolvePreparedOutput<T extends Entity>(
    item: PreparedWrite<T>,
    index: number
): T | void {
    if (item.entry.action === 'delete') {
        return
    }

    if (item.output === undefined) {
        throw new Error(`[Atoma] write: missing prepared output at index=${index}`)
    }

    return item.output
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
        status: 'confirmed',
        changes: mergeChanges(appliedChanges, versionChanges),
        results
    }
}

function shouldApplyReturnedData(entry: WriteEntry): boolean {
    if (entry.options?.returning === false) return false
    const select = entry.options?.select
    return !(select && Object.keys(select).length > 0)
}

function toWriteItemError(
    action: WriteEntry['action'],
    result: WriteItemResult
): Error {
    if (result.ok) return new Error(`[Atoma] write(${action}) failed`)

    const msg = result.error.message || 'Write failed'
    const error = new Error(`[Atoma] write(${action}) failed: ${msg}`)
    ; (error as { error?: unknown }).error = result.error
    return error
}

function toWriteManyError(
    entry: WriteEntry,
    result: Extract<WriteItemResult, { ok: false }>,
    index: number
): WriteManyItemErr {
    const current = result.current
    return {
        index,
        ok: false,
        error: toWriteItemError(entry.action, result),
        ...(current
            ? {
                current: {
                    ...(current.value !== undefined ? { value: current.value } : {}),
                    ...(typeof current.version === 'number' ? { version: current.version } : {})
                }
            }
            : {})
    }
}

function ensureWriteResultStatus(writeResult: WriteOutput, expectedCount: number) {
    if (writeResult.status === 'enqueued') return
    if (writeResult.results.length !== expectedCount) {
        throw new Error(`[Atoma] execution.write result count mismatch (expected=${expectedCount} actual=${writeResult.results.length})`)
    }
}

function toEnqueuedResults<T extends Entity>(prepared: PreparedWrites<T>): WriteManyResult<T | void> {
    if (!prepared.length) return []
    if (prepared.length !== 1) {
        throw new Error(`[Atoma] execution.write enqueued requires single entry (actual=${prepared.length})`)
    }
    const first = prepared[0]
    if (!first) {
        throw new Error('[Atoma] execution.write enqueued missing prepared write at index=0')
    }

    return [{
        index: 0,
        ok: true,
        value: resolvePreparedOutput(first, 0)
    }]
}

async function commitRemoteWrite<T extends Entity>({
    runtime,
    scope,
    prepared,
    entries,
    optimisticChanges
}: {
    runtime: Runtime
    scope: WriteScope<T>
    prepared: PreparedWrites<T>
    entries: ReadonlyArray<WriteEntry>
    optimisticChanges: ReadonlyArray<StoreChange<T>>
}): Promise<Readonly<{
    commit: WriteCommitResult<T>
    rollbackOptimistic: boolean
}>> {
    const { handle, context, signal } = scope
    const executionOptions: ExecutionOptions | undefined = signal
        ? { signal }
        : undefined
    const writeResult = await runtime.execution.write(
        { handle, context, entries },
        executionOptions
    )
    ensureWriteResultStatus(writeResult, entries.length)

    if (writeResult.status === 'enqueued') {
        return {
            commit: {
                status: 'enqueued',
                changes: optimisticChanges,
                results: toEnqueuedResults(prepared)
            },
            rollbackOptimistic: false
        }
    }

    const results: WriteManyResult<T | void> = new Array(entries.length)
    const upserts: T[] = []
    const versionUpdates: Array<{ id: EntityId; version: number }> = []

    for (let index = 0; index < entries.length; index++) {
        const preparedWrite = prepared[index]
        const entry = entries[index]
        if (!preparedWrite || !entry) {
            throw new Error(`[Atoma] missing prepared write at index=${index}`)
        }
        const itemResult = writeResult.results[index]
        if (!itemResult) {
            throw new Error(`[Atoma] execution.write missing write item result at index=${index}`)
        }

        if (!itemResult.ok) {
            results[index] = toWriteManyError(entry, itemResult, index)
            continue
        }

        if (typeof itemResult.version === 'number' && Number.isFinite(itemResult.version) && itemResult.version > 0) {
            const id = itemResult.id ?? entry.item.id
            if (id) {
                versionUpdates.push({ id, version: itemResult.version })
            }
        }

        let output: T | void = resolvePreparedOutput(preparedWrite, index)
        if (shouldApplyReturnedData(entry) && itemResult.data && typeof itemResult.data === 'object') {
            const normalized = await runtime.transform.writeback(handle, itemResult.data as T)
            if (normalized) {
                upserts.push(normalized)
                output = normalized
            }
        }

        results[index] = {
            index,
            ok: true,
            value: output
        }
    }

    const reconcile = reconcileWriteResult({
        scope,
        results,
        optimisticChanges,
        upserts,
        versionUpdates
    })
    return {
        commit: {
            status: writeResult.status,
            changes: reconcile.changes,
            results
        },
        rollbackOptimistic: reconcile.rollbackOptimistic
    }
}

export async function commitWrites<T extends Entity>(request: WriteCommitRequest<T>): Promise<WriteCommitResult<T>> {
    const { runtime, scope, prepared } = request
    const entries = prepared.map((item) => item.entry)

    if (!entries.length) {
        return {
            status: 'confirmed',
            changes: [],
            results: []
        }
    }

    const consistency = runtime.execution.getConsistency()
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
            scope,
            prepared,
            entries,
            optimisticChanges
        })
        if (remote.rollbackOptimistic) {
            rollbackOptimistic(request, optimisticChanges)
        }
        return remote.commit
    } catch (error) {
        rollbackOptimistic(request, optimisticChanges)
        throw error
    }
}
