import type { Entity } from 'atoma-types/core'
import type { OperationClient } from 'atoma-types/client/ops'
import {
    assertQueryResultData,
    assertWriteResultData,
    buildQueryOp,
    buildWriteOp,
    createOpId
} from 'atoma-types/protocol-tools'
import type {
    ExecutionSpec,
    QueryInput,
    QueryOutput,
    RuntimeWriteEntry,
    RuntimeWriteItemResult,
    WriteInput,
    WriteOutput
} from 'atoma-types/runtime'
import type { Runtime } from 'atoma-runtime'

type EntryGroup = {
    entries: RuntimeWriteEntry[]
}

function resolveWriteStatus(results: ReadonlyArray<RuntimeWriteItemResult>): WriteOutput<any>['status'] {
    if (!results.length) return 'confirmed'

    let failed = 0
    for (const result of results) {
        if (!result.ok) failed += 1
    }

    if (failed <= 0) return 'confirmed'
    if (failed >= results.length) return 'rejected'
    return 'partial'
}

function optionsKey(options: RuntimeWriteEntry['options']): string {
    if (!options || typeof options !== 'object') return ''
    return JSON.stringify(options)
}

function groupWriteEntries(entries: ReadonlyArray<RuntimeWriteEntry>): EntryGroup[] {
    const groupsByKey = new Map<string, EntryGroup>()
    const groups: EntryGroup[] = []

    for (const entry of entries) {
        const key = `${entry.action}::${optionsKey(entry.options)}`
        const existing = groupsByKey.get(key)
        if (existing) {
            existing.entries.push(entry)
            continue
        }

        const group: EntryGroup = {
            entries: [entry]
        }
        groupsByKey.set(key, group)
        groups.push(group)
    }

    return groups
}

async function executeOperationQuery<T extends Entity>(args: {
    runtime: Runtime
    resolveOperation: () => OperationClient | undefined
    input: QueryInput<T>
}): Promise<QueryOutput> {
    const { runtime, resolveOperation, input } = args
    const operation = resolveOperation()
    if (!operation) {
        throw new Error('[Atoma] operation.query: operation client 未注册')
    }
    const opId = createOpId('q', { now: runtime.now })
    const envelope = await operation.executeOperations({
        ops: [buildQueryOp({
            opId,
            resource: input.storeName,
            query: input.query
        })],
        meta: {
            v: 1,
            clientTimeMs: runtime.now(),
            requestId: opId,
            traceId: opId
        },
        ...(input.signal ? { signal: input.signal } : {})
    })

    const result = envelope.results[0]
    if (!result) {
        throw new Error('[Atoma] operation.query: missing query result')
    }

    if (!result.ok) {
        throw new Error(result.error.message || '[Atoma] operation.query failed')
    }

    const parsed = assertQueryResultData(result.data)
    return {
        data: parsed.data,
        ...(parsed.pageInfo !== undefined ? { pageInfo: parsed.pageInfo } : {})
    }
}

async function executeOperationWrite<T extends Entity>(args: {
    runtime: Runtime
    resolveOperation: () => OperationClient | undefined
    input: WriteInput<T>
}): Promise<WriteOutput<T>> {
    const { runtime, resolveOperation, input } = args
    const operation = resolveOperation()
    if (!operation) {
        throw new Error('[Atoma] operation.write: operation client 未注册')
    }
    if (!input.writeEntries.length) {
        return { status: 'confirmed' }
    }

    const groups = groupWriteEntries(input.writeEntries)
    const envelope = await operation.executeOperations({
        ops: groups.map(group => buildWriteOp({
            opId: createOpId('w', { now: runtime.now }),
            write: {
                resource: input.storeName,
                entries: group.entries
            }
        })),
        meta: {
            v: 1,
            clientTimeMs: input.opContext.timestamp,
            requestId: input.opContext.actionId,
            traceId: input.opContext.actionId
        },
        ...(input.signal ? { signal: input.signal } : {})
    })

    const results: RuntimeWriteItemResult[] = []
    for (let index = 0; index < groups.length; index++) {
        const group = groups[index]
        const result = envelope.results[index]
        if (!result) {
            throw new Error('[Atoma] operation.write: missing write result')
        }

        if (!result.ok) {
            for (const entry of group.entries) {
                results.push({
                    entryId: entry.entryId,
                    ok: false,
                    error: result.error
                })
            }
            continue
        }

        const parsed = assertWriteResultData(result.data)
        results.push(...parsed.results)
    }

    return {
        status: resolveWriteStatus(results),
        ...(results.length ? { results } : {})
    }
}

export function createOperationExecutionSpec(args: {
    runtime: Runtime
    resolveOperation: () => OperationClient | undefined
}): ExecutionSpec {
    return {
        query: async <T extends Entity>(input: QueryInput<T>): Promise<QueryOutput> => {
            return await executeOperationQuery({
                runtime: args.runtime,
                resolveOperation: args.resolveOperation,
                input
            })
        },
        write: async <T extends Entity>(input: WriteInput<T>): Promise<WriteOutput<T>> => {
            return await executeOperationWrite({
                runtime: args.runtime,
                resolveOperation: args.resolveOperation,
                input
            })
        }
    }
}
