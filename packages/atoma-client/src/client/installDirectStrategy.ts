import type { Entity, WriteStrategy } from 'atoma-types/core'
import type { OperationClient } from 'atoma-types/client/ops'
import type { QueryInput, QueryOutput, RuntimeWriteEntry, RuntimeWriteItemResult, WriteInput, WriteOutput } from 'atoma-types/runtime'
import type { Runtime } from 'atoma-runtime'
import { createOperationExecutionSpec } from './adapters/operationExecutionAdapter'

function toLocalWriteResults(entries: ReadonlyArray<RuntimeWriteEntry>): RuntimeWriteItemResult[] {
    const results: RuntimeWriteItemResult[] = []

    for (const entry of entries) {
        const rawEntityId = (entry.item as { entityId?: unknown })?.entityId
        const rawBaseVersion = (entry.item as { baseVersion?: unknown })?.baseVersion
        const entityId = (
            typeof rawEntityId === 'string' && rawEntityId.length
                ? rawEntityId
                : entry.entryId
        )
        const version = (
            typeof rawBaseVersion === 'number' && Number.isFinite(rawBaseVersion) && rawBaseVersion > 0
                ? rawBaseVersion + 1
                : 1
        )
        results.push({
            entryId: entry.entryId,
            ok: true,
            entityId,
            version
        })
    }

    return results
}

export function installDirectStrategy({
    runtime,
    operation,
    defaultStrategy = 'direct'
}: {
    runtime: Runtime
    operation: OperationClient
    defaultStrategy?: WriteStrategy
}): () => void {
    const unregisterDirect = runtime.execution.register('direct', {
        query: async <T extends Entity>(input: QueryInput<T>): Promise<QueryOutput> => {
            const local = runtime.engine.query.evaluate({
                state: input.handle.state,
                query: input.query
            })

            return {
                data: local.data,
                ...(local.pageInfo !== undefined ? { pageInfo: local.pageInfo } : {})
            }
        },
        write: async <T extends Entity>(input: WriteInput<T>): Promise<WriteOutput<T>> => {
            const results = toLocalWriteResults(input.writeEntries)
            return {
                status: 'confirmed',
                ...(results.length ? { results } : {})
            }
        }
    })

    const unregisterOperation = runtime.execution.register(
        'operation',
        createOperationExecutionSpec({ runtime, operation })
    )

    const restoreDefault = runtime.execution.setDefault(defaultStrategy)

    return () => {
        restoreDefault()
        unregisterOperation()
        unregisterDirect()
    }
}
