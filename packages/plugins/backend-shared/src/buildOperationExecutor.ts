import type { Entity } from '@atoma-js/types/core'
import type { OperationClient } from '@atoma-js/types/client/ops'
import {
    assertQueryResultData,
    assertWriteResultData,
    buildQueryOp,
    buildWriteOp,
    createOpId
} from '@atoma-js/types/tools'
import type {
    WriteEntry as ProtocolWriteEntry
} from '@atoma-js/types/protocol'
import type {
    ExecutionOptions,
    ExecutionRegistration,
    ExecutionQueryOutput,
    QueryRequest,
    WriteEntry as RuntimeWriteEntry,
    WriteItemResult,
    WriteRequest,
    WriteOutput
} from '@atoma-js/types/runtime'

type OperationRuntime = Readonly<{
    now: () => number
}>

type WriteGroup = {
    entries: Array<{
        index: number
        entry: RuntimeWriteEntry
    }>
}

type WriteEntryEncoder = <T extends Entity>(args: {
    request: WriteRequest<T>
    entries: ReadonlyArray<RuntimeWriteEntry>
}) => ReadonlyArray<ProtocolWriteEntry>

function createOperationError(message: string): Error {
    return new Error(message)
}

function normalizeOperationError(args: {
    error: unknown
    fallbackMessage: string
}): Error {
    if (args.error instanceof Error) {
        return args.error
    }
    return createOperationError(args.fallbackMessage)
}

function resolveWriteStatus(results: ReadonlyArray<WriteItemResult>): WriteOutput['status'] {
    if (!results.length) return 'confirmed'

    let failed = 0
    for (const result of results) {
        if (!result.ok) failed += 1
    }

    if (failed <= 0) return 'confirmed'
    if (failed >= results.length) return 'rejected'
    return 'partial'
}

function writeOptionsKey(options: RuntimeWriteEntry['options']): string {
    if (!options || typeof options !== 'object') return ''
    return JSON.stringify(options)
}

function groupWriteEntries(entries: ReadonlyArray<RuntimeWriteEntry>): WriteGroup[] {
    const groupsByKey = new Map<string, WriteGroup>()
    const groups: WriteGroup[] = []

    entries.forEach((entry, index) => {
        const key = `${entry.action}::${writeOptionsKey(entry.options)}`
        const existing = groupsByKey.get(key)
        if (existing) {
            existing.entries.push({ index, entry })
            return
        }

        const group: WriteGroup = {
            entries: [{ index, entry }]
        }
        groupsByKey.set(key, group)
        groups.push(group)
    })

    return groups
}

async function executeOperationQuery<T extends Entity>(args: {
    runtime: OperationRuntime
    operationClient: OperationClient
    request: QueryRequest<T>
    options?: ExecutionOptions
}): Promise<ExecutionQueryOutput<T>> {
    const { runtime, operationClient, request, options } = args
    try {
        const opId = createOpId('q', { now: runtime.now })
        const envelope = await operationClient.executeOperations({
            ops: [buildQueryOp({
                opId,
                resource: request.handle.storeName,
                query: request.query
            })],
            meta: {
                v: 1,
                clientTimeMs: runtime.now(),
                requestId: opId,
                traceId: opId
            },
            ...(options?.signal ? { signal: options.signal } : {})
        })

        const result = envelope.results[0]
        if (!result) {
            throw createOperationError('[Atoma] operation.query: missing query result')
        }

        if (!result.ok) {
            throw createOperationError(result.error.message || '[Atoma] operation.query failed')
        }

        const parsed = assertQueryResultData(result.data)
        return {
            data: parsed.data,
            source: 'remote',
            ...(parsed.pageInfo !== undefined ? { pageInfo: parsed.pageInfo } : {})
        }
    } catch (error) {
        throw normalizeOperationError({
            error,
            fallbackMessage: `[Atoma] operation.query failed: ${request.handle.storeName}`
        })
    }
}

async function executeOperationWrite<T extends Entity>(args: {
    runtime: OperationRuntime
    operationClient: OperationClient
    request: WriteRequest<T>
    writeEntryEncoder?: WriteEntryEncoder
    options?: ExecutionOptions
}): Promise<WriteOutput> {
    const { runtime, operationClient, request, writeEntryEncoder, options } = args
    try {
        if (!request.entries.length) {
            return {
                status: 'confirmed',
                results: []
            }
        }

        const protocolEntries = (writeEntryEncoder
            ? writeEntryEncoder({
                request,
                entries: request.entries
            })
            : request.entries) as ReadonlyArray<ProtocolWriteEntry>
        const groups = groupWriteEntries(request.entries)
        const envelope = await operationClient.executeOperations({
            ops: groups.map(group => buildWriteOp({
                opId: createOpId('w', { now: runtime.now }),
                write: {
                    resource: request.handle.storeName,
                    entries: group.entries.map((value) => {
                        const protocolEntry = protocolEntries[value.index]
                        if (!protocolEntry) {
                            throw createOperationError(`[Atoma] operation.write: missing protocol write entry: ${value.index}`)
                        }
                        return protocolEntry
                    })
                }
            })),
            meta: {
                v: 1,
                clientTimeMs: request.context.timestamp,
                requestId: request.context.id,
                traceId: request.context.id
            },
            ...(options?.signal ? { signal: options.signal } : {})
        })

        const orderedResults: WriteItemResult[] = new Array(request.entries.length)
        for (let index = 0; index < groups.length; index++) {
            const group = groups[index]
            const result = envelope.results[index]
            if (!result) {
                throw createOperationError('[Atoma] operation.write: missing write result')
            }

            if (!result.ok) {
                for (const value of group.entries) {
                    orderedResults[value.index] = {
                        ok: false,
                        error: result.error
                    }
                }
                continue
            }

            const parsed = assertWriteResultData(result.data, {
                expectedLength: group.entries.length
            })
            for (let itemIndex = 0; itemIndex < group.entries.length; itemIndex++) {
                const value = group.entries[itemIndex]
                orderedResults[value.index] = parsed.results[itemIndex]
            }
        }

        for (let index = 0; index < orderedResults.length; index++) {
            if (orderedResults[index]) continue
            throw createOperationError(`[Atoma] operation.write: missing write item result: ${index}`)
        }

        const results = orderedResults as WriteItemResult[]
        return {
            status: resolveWriteStatus(results),
            results
        }
    } catch (error) {
        throw normalizeOperationError({
            error,
            fallbackMessage: `[Atoma] operation.write failed: ${request.context.id}`
        })
    }
}

export function buildOperationExecutor(args: {
    runtime: OperationRuntime
    operationClient: OperationClient
    writeEntryEncoder?: WriteEntryEncoder
}): ExecutionRegistration {
    return {
        query: async <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions): Promise<ExecutionQueryOutput<T>> => {
            return await executeOperationQuery({
                runtime: args.runtime,
                operationClient: args.operationClient,
                request,
                options
            })
        },
        write: async <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions): Promise<WriteOutput> => {
            return await executeOperationWrite({
                runtime: args.runtime,
                operationClient: args.operationClient,
                request,
                writeEntryEncoder: args.writeEntryEncoder,
                options
            })
        }
    }
}
