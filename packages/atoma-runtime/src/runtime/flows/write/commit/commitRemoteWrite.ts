import type {
    Entity,
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
import type { EntityId } from 'atoma-types/shared'
import type {
    PreparedWrites,
    WriteScope
} from '../types'

type CommitRemoteWriteInput<T extends Entity> = Readonly<{
    scope: WriteScope<T>
    prepared: PreparedWrites<T>
    entries: ReadonlyArray<WriteEntry>
}>

type EnqueuedRemoteWrite<T extends Entity> = Readonly<{
    status: 'enqueued'
    results: WriteManyResult<T | void>
}>

type ConfirmedRemoteWrite<T extends Entity> = Readonly<{
    status: 'confirmed'
    results: WriteManyResult<T | void>
    upserts: T[]
    versionUpdates: Array<{ id: EntityId; version: number }>
}>

export type CommitRemoteWriteOutput<T extends Entity> =
    | EnqueuedRemoteWrite<T>
    | ConfirmedRemoteWrite<T>

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
        value: first.output as T | void
    }]
}

export async function commitRemoteWrite<T extends Entity>({
    runtime,
    request
}: {
    runtime: Runtime
    request: CommitRemoteWriteInput<T>
}): Promise<CommitRemoteWriteOutput<T>> {
    const { scope, prepared, entries } = request
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
            status: 'enqueued',
            results: toEnqueuedResults(prepared)
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

        let output = preparedWrite.output
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
            value: output as T | void
        }
    }

    return {
        status: 'confirmed',
        results,
        upserts,
        versionUpdates
    }
}
