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
    mergeChanges,
    toChange
} from 'atoma-core/store'
import type {
    WriteCommitRequest,
    OptimisticState,
    WritePlan,
    WritePlanEntry,
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

function toOptimisticChanges<T extends Entity>(plan: WritePlan<T>): StoreChange<T>[] {
    const changes: StoreChange<T>[] = []
    plan.forEach(({ optimistic }) => {
        const id = optimistic.id
        if (!id) return
        if (optimistic.before === undefined && optimistic.after === undefined) return
        changes.push(toChange({
            id,
            before: optimistic.before,
            after: optimistic.after
        }))
    })
    return changes
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
    if (consistency.commit !== 'optimistic' || !plan.length) {
        return createEmptyOptimisticState(before)
    }

    const optimisticChanges = toOptimisticChanges(plan)
    if (!optimisticChanges.length) {
        return createEmptyOptimisticState(before)
    }

    const optimistic = handle.state.apply(optimisticChanges)
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
    results,
    primaryPlan
}: {
    request: WriteCommitRequest<T>
    results: ReadonlyArray<WriteItemResult>
    primaryPlan?: WritePlanEntry<T>
}): Promise<{ writeback?: StoreWritebackArgs<T>; output?: T }> {
    const { plan } = request
    if (!plan.length || !results.length) return {}

    const resultByEntryId = new Map<string, WriteItemResult>()
    for (const itemResult of results) {
        if (typeof itemResult.entryId !== 'string' || !itemResult.entryId) {
            throw new Error('[Atoma] write item result missing entryId')
        }
        resultByEntryId.set(itemResult.entryId, itemResult)
    }

    const upserts: T[] = []
    const versionUpdates: Array<{ id: EntityId; version: number }> = []
    let output: T | undefined

    const primary = primaryPlan
        ? {
            action: primaryPlan.entry.action,
            id: primaryPlan.optimistic.id
        }
        : undefined

    for (const planEntry of plan) {
        const { entry, optimistic } = planEntry
        const itemResult = resultByEntryId.get(entry.entryId)
        if (!itemResult) {
            throw new Error(`[Atoma] missing write item result for entryId=${entry.entryId}`)
        }

        if (!itemResult.ok) throw toWriteItemError(entry.action, itemResult)

        if (typeof itemResult.version === 'number' && Number.isFinite(itemResult.version) && itemResult.version > 0) {
            const fallbackId = entry.item.id
            const id = itemResult.id ?? optimistic.id ?? fallbackId
            if (id) {
                versionUpdates.push({ id, version: itemResult.version })
            }
        }

        if (!shouldApplyReturnedData(entry) || !itemResult.data || typeof itemResult.data !== 'object') continue

        const normalized = await request.runtime.transform.writeback(request.scope.handle, itemResult.data as T)
        if (!normalized) continue

        upserts.push(normalized)
        if (!output && primary && entry.action === primary.action) {
            if (!primary.id || optimistic.id === primary.id) {
                output = normalized
            }
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
    if ((writeResult.status === 'rejected' || writeResult.status === 'partial') && !writeResult.results?.length) {
        throw new Error(`[Atoma] execution.write ${writeResult.status} without item results`)
    }
}

export async function commitWrite<T extends Entity>(request: WriteCommitRequest<T>): Promise<WriteCommitResult<T>> {
    const { runtime, scope, plan } = request
    const { handle, context, route, signal } = scope
    const executionOptions: ExecutionOptions | undefined = (route ?? signal)
        ? { route, signal }
        : undefined
    const consistency = runtime.execution.resolveConsistency(handle, executionOptions)
    const optimisticState = applyOptimistic({
        request,
        plan,
        consistency
    })
    const primaryPlan = plan.length === 1 ? plan[0] : undefined

    try {
        const fallbackOutput = primaryPlan && primaryPlan.entry.action !== 'delete'
            ? primaryPlan.optimistic.after
            : undefined

        let transactionOutput: T | undefined = fallbackOutput
        let transactionChanges: ReadonlyArray<StoreChange<T>> = []

        if (plan.length) {
            const writeResult = await runtime.execution.write(
                { handle, context, entries: plan.map((entry) => entry.entry) },
                executionOptions
            )
            ensureWriteResultStatus(writeResult)

            const resolved = (writeResult.results && writeResult.results.length)
                ? await resolveResult({ request, results: writeResult.results, primaryPlan })
                : {}

            transactionOutput = resolved.output ?? fallbackOutput
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
