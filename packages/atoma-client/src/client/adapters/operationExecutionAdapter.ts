import type { Entity } from 'atoma-types/core'
import type { OperationClient } from 'atoma-types/client/ops'
import { createCodedError, isCodedError } from 'atoma-shared'
import {
    assertQueryResultData,
    assertWriteResultData,
    buildQueryOp,
    buildWriteOp,
    createOpId
} from 'atoma-types/protocol-tools'
import type {
    ExecutionError,
    ExecutionOptions,
    ExecutionSpec,
    QueryOutput,
    QueryRequest,
    RuntimeWriteEntry,
    RuntimeWriteItemResult,
    WriteRequest,
    WriteOutput
} from 'atoma-types/runtime'
import type { Runtime } from 'atoma-runtime'

type EntryGroup = {
    entries: RuntimeWriteEntry[]
}

function createOperationError(args: {
    code: 'E_OPERATION_CLIENT_MISSING' | 'E_OPERATION_RESULT_MISSING' | 'E_OPERATION_FAILED'
    message: string
    retryable?: boolean
    details?: Readonly<Record<string, unknown>>
    cause?: unknown
}): ExecutionError {
    return createCodedError({
        code: args.code,
        message: args.message,
        retryable: args.retryable,
        details: args.details,
        cause: args.cause
    }) as ExecutionError
}

function normalizeOperationError(args: {
    error: unknown
    fallbackMessage: string
    details?: Readonly<Record<string, unknown>>
}): ExecutionError {
    if (isCodedError(args.error)) {
        return args.error as ExecutionError
    }
    return createOperationError({
        code: 'E_OPERATION_FAILED',
        message: args.fallbackMessage,
        retryable: true,
        details: args.details,
        cause: args.error
    })
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
    request: QueryRequest<T>
    options?: ExecutionOptions
}): Promise<QueryOutput> {
    const { runtime, resolveOperation, request, options } = args
    try {
        const operation = resolveOperation()
        if (!operation) {
            throw createOperationError({
                code: 'E_OPERATION_CLIENT_MISSING',
                message: '[Atoma] operation.query: operation client 未注册',
                retryable: false
            })
        }
        const opId = createOpId('q', { now: runtime.now })
        const envelope = await operation.executeOperations({
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
            throw createOperationError({
                code: 'E_OPERATION_RESULT_MISSING',
                message: '[Atoma] operation.query: missing query result',
                retryable: true
            })
        }

        if (!result.ok) {
            throw createOperationError({
                code: 'E_OPERATION_FAILED',
                message: result.error.message || '[Atoma] operation.query failed',
                retryable: result.error.retryable === true,
                details: {
                    errorCode: result.error.code,
                    kind: result.error.kind
                },
                cause: result.error
            })
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
            fallbackMessage: '[Atoma] operation.query failed',
            details: {
                storeName: String(request.handle.storeName)
            }
        })
    }
}

async function executeOperationWrite<T extends Entity>(args: {
    runtime: Runtime
    resolveOperation: () => OperationClient | undefined
    request: WriteRequest<T>
    options?: ExecutionOptions
}): Promise<WriteOutput<T>> {
    const { runtime, resolveOperation, request, options } = args
    try {
        const operation = resolveOperation()
        if (!operation) {
            throw createOperationError({
                code: 'E_OPERATION_CLIENT_MISSING',
                message: '[Atoma] operation.write: operation client 未注册',
                retryable: false
            })
        }
        if (!request.entries.length) {
            return { status: 'confirmed' }
        }

        const groups = groupWriteEntries(request.entries)
        const envelope = await operation.executeOperations({
            ops: groups.map(group => buildWriteOp({
                opId: createOpId('w', { now: runtime.now }),
                write: {
                    resource: request.handle.storeName,
                    entries: group.entries
                }
            })),
            meta: {
                v: 1,
                clientTimeMs: request.opContext.timestamp,
                requestId: request.opContext.actionId,
                traceId: request.opContext.actionId
            },
            ...(options?.signal ? { signal: options.signal } : {})
        })

        const results: RuntimeWriteItemResult[] = []
        for (let index = 0; index < groups.length; index++) {
            const group = groups[index]
            const result = envelope.results[index]
            if (!result) {
                throw createOperationError({
                    code: 'E_OPERATION_RESULT_MISSING',
                    message: '[Atoma] operation.write: missing write result',
                    retryable: true
                })
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
    } catch (error) {
        throw normalizeOperationError({
            error,
            fallbackMessage: '[Atoma] operation.write failed',
            details: {
                actionId: request.opContext.actionId
            }
        })
    }
}

export function createOperationExecutionSpec(args: {
    runtime: Runtime
    resolveOperation: () => OperationClient | undefined
}): ExecutionSpec {
    return {
        query: async <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions): Promise<QueryOutput> => {
            return await executeOperationQuery({
                runtime: args.runtime,
                resolveOperation: args.resolveOperation,
                request,
                options
            })
        },
        write: async <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions): Promise<WriteOutput<T>> => {
            return await executeOperationWrite({
                runtime: args.runtime,
                resolveOperation: args.resolveOperation,
                request,
                options
            })
        }
    }
}
