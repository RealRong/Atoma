import type {
    Entity,
    StoreChange,
    StoreWritebackArgs,
} from 'atoma-types/core'
import type {
    ExecutionOptions,
    WriteEntry,
    WriteItemResult,
    WriteOutput,
    WriteConsistency
} from 'atoma-types/runtime'
import type { EntityId } from 'atoma-types/shared'
import {
    invertChanges,
    mergeChanges
} from 'atoma-core/store'
import type {
    WriteCommitRequest,
    OptimisticState,
    WritePlan,
    WriteCommitResult,
} from '../types'

function createEmptyOptimisticState<T extends Entity>(before: ReadonlyMap<EntityId, T>): OptimisticState<T> {
    return {
        before,
        after: before,
        changedIds: new Set<EntityId>(),
        changes: []
    }
}

function applyOptimistic<T extends Entity>({
    request,
    plan,
    consistency
}: {
    request: WriteCommitRequest<T>
    plan: WritePlan<T>
    consistency: WriteConsistency
}): OptimisticState<T> {
    const handle = request.scope.handle
    const before = handle.state.snapshot() as Map<EntityId, T>
    if (consistency.commit !== 'optimistic' || !plan.entries.length) {
        return createEmptyOptimisticState(before)
    }

    if (!plan.optimisticChanges.length) {
        return createEmptyOptimisticState(before)
    }

    const optimistic = handle.state.apply(plan.optimisticChanges)
    if (!optimistic) {
        return createEmptyOptimisticState(before)
    }

    return {
        before,
        after: optimistic.after,
        changedIds: optimistic.changedIds,
        changes: optimistic.changes
    }
}

function rollbackOptimistic<T extends Entity>(request: WriteCommitRequest<T>, optimisticState: OptimisticState<T>) {
    if (!optimisticState.changes.length) return
    request.scope.handle.state.apply(invertChanges(optimisticState.changes))
}

async function resolveResult<T extends Entity>({
    request,
    entries,
    results,
    primaryEntryId
}: {
    request: WriteCommitRequest<T>
    entries: ReadonlyArray<WriteEntry>
    results: ReadonlyArray<WriteItemResult>
    primaryEntryId?: string
}): Promise<{ writeback?: StoreWritebackArgs<T>; output?: T }> {
    if (!entries.length) return {}
    if (results.length !== entries.length) {
        throw new Error(`[Atoma] write item result count mismatch (expected=${entries.length} actual=${results.length})`)
    }

    const upserts: T[] = []
    const versionUpdates: Array<{ id: EntityId; version: number }> = []
    let output: T | undefined

    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]
        const itemResult = results[index]
        if (!itemResult) {
            throw new Error(`[Atoma] missing write item result at index=${index}`)
        }
        if (itemResult.entryId !== entry.entryId) {
            throw new Error(
                `[Atoma] write item result entryId mismatch at index=${index} expected=${entry.entryId} actual=${String(itemResult.entryId)}`
            )
        }

        if (!itemResult.ok) throw toWriteItemError(entry.action, itemResult)

        if (typeof itemResult.version === 'number' && Number.isFinite(itemResult.version) && itemResult.version > 0) {
            const id = itemResult.id ?? entry.item.id
            if (id) {
                versionUpdates.push({ id, version: itemResult.version })
            }
        }

        if (!shouldApplyReturnedData(entry) || !itemResult.data || typeof itemResult.data !== 'object') continue

        const normalized = await request.runtime.transform.writeback(request.scope.handle, itemResult.data as T)
        if (!normalized) continue

        upserts.push(normalized)
        if (!output && primaryEntryId && entry.entryId === primaryEntryId) {
            output = normalized
        }
    }

    const writeback: StoreWritebackArgs<T> | undefined =
        (upserts.length || versionUpdates.length)
            ? { upserts, versionUpdates }
            : undefined

    return { writeback, output }
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

function ensureWriteResultStatus(writeResult: WriteOutput) {
    if (writeResult.status === 'enqueued') return
    if (writeResult.results.length === 0) {
        throw new Error(`[Atoma] execution.write ${writeResult.status} without item results`)
    }
}

export async function commitWrite<T extends Entity>(request: WriteCommitRequest<T>): Promise<WriteCommitResult<T>> {
    const { runtime, scope, plan } = request
    const { handle, context, route, signal } = scope
    const writeEntries = plan.entries
    const executionOptions: ExecutionOptions | undefined = (route ?? signal)
        ? { route, signal }
        : undefined
    const consistency = runtime.execution.resolveConsistency(handle, executionOptions)
    const optimisticState = applyOptimistic({
        request,
        plan,
        consistency
    })
    const primaryEntryId = writeEntries.length === 1 ? writeEntries[0]?.entryId : undefined

    try {
        let transactionOutput: T | undefined
        let transactionChanges: ReadonlyArray<StoreChange<T>> = []

        if (writeEntries.length) {
            const writeResult = await runtime.execution.write(
                { handle, context, entries: writeEntries },
                executionOptions
            )
            ensureWriteResultStatus(writeResult)

            const resolved = writeResult.status === 'enqueued'
                ? {}
                : await resolveResult({
                    request,
                    entries: writeEntries,
                    results: writeResult.results,
                    primaryEntryId
                })

            transactionOutput = resolved.output
            transactionChanges = resolved.writeback
                ? (handle.state.writeback(resolved.writeback)?.changes ?? [])
                : []
        }

        return {
            changes: mergeChanges(optimisticState.changes, transactionChanges),
            ...(transactionOutput !== undefined ? { output: transactionOutput } : {})
        }
    } catch (error) {
        rollbackOptimistic(request, optimisticState)
        throw error
    }
}
