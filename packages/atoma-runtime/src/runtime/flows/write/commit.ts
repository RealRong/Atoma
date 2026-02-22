import type {
    Entity,
    StoreChange,
    WriteManyItemErr,
    WriteManyResult,
} from 'atoma-types/core'
import type {
    ExecutionOptions,
    Runtime,
    WriteEntry,
    WriteItemResult,
    WriteOutput
} from 'atoma-types/runtime'
import { mergeChanges } from 'atoma-core/store'
import type {
    PreparedWrites,
    WriteCommitRequest,
    WriteCommitResult,
    WriteScope
} from './contracts'
import {
    applyLocalWrites,
    applyOptimistic,
    rollbackOptimistic
} from './apply'
import { resolvePreparedOutput } from './output'

type ReconcileWriteResult<T extends Entity> = Readonly<{
    changes: ReadonlyArray<StoreChange<T>>
    rollbackChanges: ReadonlyArray<StoreChange<T>>
}>

function reconcileWriteResult<T extends Entity>({
    scope,
    results,
    optimisticByIndex,
    upserts
}: {
    scope: WriteScope<T>
    results: WriteManyResult<T | void>
    optimisticByIndex: ReadonlyArray<ReadonlyArray<StoreChange<T>>>
    upserts: T[]
}): ReconcileWriteResult<T> {
    const entries = upserts.map((item) => ({
        action: 'upsert' as const,
        item
    }))
    const transactionChanges = entries.length
        ? (scope.handle.state.writeback(entries)?.changes ?? [])
        : []

    const retainedOptimistic: StoreChange<T>[] = []
    const rollbackChanges: StoreChange<T>[] = []
    results.forEach((result, index) => {
        const optimistic = optimisticByIndex[index]
        if (!optimistic?.length) return
        if (result?.ok) {
            retainedOptimistic.push(...optimistic)
            return
        }
        rollbackChanges.push(...optimistic)
    })

    return {
        changes: mergeChanges(retainedOptimistic, transactionChanges),
        rollbackChanges
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
                    ...(current.value !== undefined ? { value: current.value } : {})
                }
            }
            : {})
    }
}

function ensureWriteResultStatus(writeResult: WriteOutput, expectedCount: number) {
    if (writeResult.results.length !== expectedCount) {
        throw new Error(`[Atoma] execution.write result count mismatch (expected=${expectedCount} actual=${writeResult.results.length})`)
    }
}

async function commitRemoteWrite<T extends Entity>({
    runtime,
    scope,
    prepared,
    entries,
    optimisticByIndex
}: {
    runtime: Runtime
    scope: WriteScope<T>
    prepared: PreparedWrites<T>
    entries: ReadonlyArray<WriteEntry>
    optimisticByIndex: ReadonlyArray<ReadonlyArray<StoreChange<T>>>
}): Promise<Readonly<{
    commit: WriteCommitResult<T>
    rollbackChanges: ReadonlyArray<StoreChange<T>>
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

    const results: WriteManyResult<T | void> = new Array(entries.length)
    const upserts: T[] = []

    const mapped = await Promise.all(
        entries.map(async (entry, index) => {
            const preparedWrite = prepared[index]
            if (!preparedWrite) {
                throw new Error(`[Atoma] missing prepared write at index=${index}`)
            }
            const itemResult = writeResult.results[index]
            if (!itemResult) {
                throw new Error(`[Atoma] execution.write missing write item result at index=${index}`)
            }

            if (!itemResult.ok) {
                return { isError: true as const, index, result: toWriteManyError(entry, itemResult, index) }
            }

            let output: T | void = resolvePreparedOutput(preparedWrite, index)
            let upsert: T | undefined

            if (shouldApplyReturnedData(entry) && itemResult.data && typeof itemResult.data === 'object') {
                const normalized = await runtime.processor.writeback(handle, itemResult.data as T)
                if (normalized) {
                    upsert = normalized
                    output = normalized
                }
            }

            return {
                isError: false as const,
                index,
                result: { index, ok: true, value: output } as Extract<WriteManyResult<T | void>[0], { ok: true }>,
                upsert
            }
        })
    )

    for (const item of mapped) {
        if (item.isError) {
            results[item.index] = item.result
        } else {
            results[item.index] = item.result
            if (item.upsert) upserts.push(item.upsert)
        }
    }

    const reconcile = reconcileWriteResult({
        scope,
        results,
        optimisticByIndex,
        upserts
    })
    return {
        commit: {
            status: writeResult.status,
            changes: reconcile.changes,
            results
        },
        rollbackChanges: reconcile.rollbackChanges
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
    const optimistic = applyOptimistic({
        request,
        consistency
    })

    if (!runtime.execution.hasExecutor('write')) {
        return applyLocalWrites({
            request,
            optimisticChanges: optimistic.merged
        })
    }

    try {
        const remote = await commitRemoteWrite({
            runtime,
            scope,
            prepared,
            entries,
            optimisticByIndex: optimistic.byIndex
        })
        if (remote.rollbackChanges.length) {
            rollbackOptimistic(request, remote.rollbackChanges)
        }
        return remote.commit
    } catch (error) {
        rollbackOptimistic(request, optimistic.merged)
        throw error
    }
}
