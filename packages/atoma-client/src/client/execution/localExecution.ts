import type { Entity } from 'atoma-types/core'
import type {
    ExecutionSpec,
    QueryOutput,
    QueryRequest,
    WriteEntry,
    WriteItemResult,
    WriteOutput,
    WriteRequest
} from 'atoma-types/runtime'
import type { Runtime } from 'atoma-runtime'

function buildWriteResults(entries: ReadonlyArray<WriteEntry>): WriteItemResult[] {
    const results: WriteItemResult[] = []

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

export function buildLocalExecutor({
    runtime
}: {
    runtime: Runtime
}): ExecutionSpec {
    return {
        query: async <T extends Entity>(request: QueryRequest<T>): Promise<QueryOutput> => {
            const local = runtime.engine.query.evaluate({
                state: request.handle.state,
                query: request.query
            })

            return {
                data: local.data,
                source: 'local',
                ...(local.pageInfo !== undefined ? { pageInfo: local.pageInfo } : {})
            }
        },
        write: async <T extends Entity>(request: WriteRequest<T>): Promise<WriteOutput<T>> => {
            const results = buildWriteResults(request.entries)
            return {
                status: 'confirmed',
                ...(results.length ? { results } : {})
            }
        }
    }
}
