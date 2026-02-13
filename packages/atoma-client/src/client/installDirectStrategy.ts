import type { Entity } from 'atoma-types/core'
import { assertQueryResultData, assertWriteResultData, buildQueryOp, buildWriteOp, createOpId } from 'atoma-types/protocol-tools'
import type { WriteEntry, WriteItemResult } from 'atoma-types/protocol'
import type { QueryInput, QueryOutput, WriteInput, WriteOutput } from 'atoma-types/runtime'
import { Runtime } from 'atoma-runtime'
import { OperationPipeline } from '../plugins/OperationPipeline'

type EntryGroup = {
    entries: WriteEntry[]
}

function optionsKey(options: WriteEntry['options']): string {
    if (!options || typeof options !== 'object') return ''
    return JSON.stringify(options)
}

function groupWriteEntries(entries: ReadonlyArray<WriteEntry>): EntryGroup[] {
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

export function installDirectStrategy({
    runtime,
    pipeline
}: {
    runtime: Runtime
    pipeline: OperationPipeline
}): () => void {
    const unregister = runtime.strategy.register('direct', {
        query: async <T extends Entity>(input: QueryInput<T>): Promise<QueryOutput> => {
            const opId = createOpId('q', { now: runtime.now })
            const envelope = await pipeline.executeOperations({
                req: {
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
                },
                ctx: {
                    clientId: runtime.id
                }
            })

            const result = envelope.results[0]
            if (!result) {
                throw new Error('[Atoma] direct.query: missing query result')
            }

            if (!result.ok) {
                throw new Error(result.error.message || '[Atoma] direct.query failed')
            }

            const parsed = assertQueryResultData(result.data)
            return {
                data: parsed.data,
                ...(parsed.pageInfo !== undefined ? { pageInfo: parsed.pageInfo } : {})
            }
        },
        write: async <T extends Entity>(input: WriteInput<T>): Promise<WriteOutput<T>> => {
            if (!input.writeEntries.length) {
                return { status: 'confirmed' }
            }

            const groups = groupWriteEntries(input.writeEntries)
            const envelope = await pipeline.executeOperations({
                req: {
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
                },
                ctx: {
                    clientId: runtime.id
                }
            })

            const results: WriteItemResult[] = []
            for (let index = 0; index < groups.length; index++) {
                const group = groups[index]
                const result = envelope.results[index]
                if (!result) {
                    throw new Error('[Atoma] direct.write: missing write result')
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
                status: 'confirmed',
                ...(results.length ? { results } : {})
            }
        }
    })

    const restoreDefault = runtime.strategy.setDefault('direct')

    return () => {
        restoreDefault()
        unregister()
    }
}
