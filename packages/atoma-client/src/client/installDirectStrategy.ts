import type { Entity, WriteRoute } from 'atoma-types/core'
import { OPERATION_CLIENT_TOKEN } from 'atoma-types/client/ops'
import type { QueryInput, QueryOutput, RuntimeWriteEntry, RuntimeWriteItemResult, WriteInput, WriteOutput } from 'atoma-types/runtime'
import type { Runtime } from 'atoma-runtime'
import { createOperationExecutionSpec } from './adapters/operationExecutionAdapter'
import type { ServiceRegistry } from '../plugins/ServiceRegistry'

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
    services,
    defaultRoute = 'direct-local'
}: {
    runtime: Runtime
    services: ServiceRegistry
    defaultRoute?: WriteRoute
}): () => void {
    return runtime.execution.apply({
        id: 'builtin.direct',
        executors: {
            local: {
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
            },
            operation: createOperationExecutionSpec({
                runtime,
                resolveOperation: () => services.resolve(OPERATION_CLIENT_TOKEN)
            })
        },
        routes: {
            'direct-local': {
                query: 'local',
                write: 'local'
            },
            'direct-operation': {
                query: 'operation',
                write: 'operation'
            }
        },
        defaultRoute
    })
}
