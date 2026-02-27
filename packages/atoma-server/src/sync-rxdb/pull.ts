import type { SyncDocument, SyncPullResponse } from 'atoma-types/sync'
import { parseSyncPullRequest, wrapProtocolError } from 'atoma-types/protocol-tools'
import type { AtomaServerConfig } from '../config'
import type { HandleResult } from '../runtime/http'
import { throwError } from '../error'

type PullExecutor<Ctx> = Readonly<{
    handle: (args: {
        incoming: unknown
        method: string
        runtime: {
            requestId: string
            traceId?: string
            logger: any
            ctx: Ctx
        }
    }) => Promise<HandleResult>
}>

export function createSyncRxdbPullExecutor<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    readBodyJson: (incoming: unknown) => Promise<unknown>
}): PullExecutor<Ctx> {
    return {
        handle: async ({ incoming, method, runtime }) => {
            if (method !== 'POST') {
                throwError('METHOD_NOT_ALLOWED', 'POST required', {
                    kind: 'validation',
                    traceId: runtime.traceId,
                    requestId: runtime.requestId
                })
            }

            const sync = args.config.adapter.sync
            if (!sync || args.config.sync?.enabled === false) {
                throwError('INVALID_REQUEST', 'Sync adapter is required when sync is enabled', {
                    kind: 'validation',
                    traceId: runtime.traceId,
                    requestId: runtime.requestId
                })
            }

            const defaultBatchSize = args.config.sync?.pull?.defaultBatchSize ?? 200
            const maxBatchSize = args.config.sync?.pull?.maxBatchSize ?? 500

            const request = parsePullRequest(
                await args.readBodyJson(incoming),
                { defaultBatchSize }
            )

            const cursor = Math.max(0, Math.floor(request.checkpoint?.cursor ?? 0))
            const batchSize = Math.min(
                Math.max(1, Math.floor(request.batchSize)),
                Math.max(1, Math.floor(maxBatchSize))
            )
            const resource = String(request.resource)

            const changes = await sync.pullChangesByResource({
                resource,
                cursor,
                limit: batchSize
            })
            const nextCursor = changes.length
                ? Math.max(cursor, Math.floor(changes[changes.length - 1]!.cursor))
                : cursor

            const latestById = new Map<string, (typeof changes)[number]>()
            for (const change of changes) {
                const id = String(change.id ?? '')
                if (!id) continue
                if (latestById.has(id)) {
                    latestById.delete(id)
                }
                latestById.set(id, change)
            }
            const latestChanges = Array.from(latestById.values())
            const upsertIds = latestChanges
                .filter(change => change.kind === 'upsert')
                .map(change => String(change.id))

            const entityById = new Map<string, any>()
            if (upsertIds.length) {
                const queryResult = await args.config.adapter.orm.findMany(resource, {
                    filter: { op: 'in', field: 'id', values: upsertIds },
                    page: { mode: 'offset', limit: upsertIds.length }
                })
                const data = Array.isArray(queryResult.data) ? queryResult.data : []
                for (const item of data) {
                    if (!item || typeof item !== 'object') continue
                    const id = String((item as any).id ?? '')
                    if (!id) continue
                    entityById.set(id, item)
                }
            }

            const documents: SyncDocument[] = latestChanges.map((change) => {
                const id = String(change.id)
                if (change.kind === 'delete') {
                    return {
                        id,
                        version: Math.max(1, Math.floor(change.serverVersion)),
                        _deleted: true,
                        atomaSync: {
                            resource
                        }
                    }
                }

                const current = entityById.get(id)
                if (!current || typeof current !== 'object') {
                    return {
                        id,
                        version: Math.max(1, Math.floor(change.serverVersion)),
                        _deleted: true,
                        atomaSync: {
                            resource
                        }
                    }
                }

                const version = Number((current as any).version)
                return {
                    ...(current as any),
                    id,
                    version: Number.isFinite(version) && version > 0
                        ? Math.floor(version)
                        : Math.max(1, Math.floor(change.serverVersion)),
                    atomaSync: {
                        resource
                    }
                } as SyncDocument
            })

            const response: SyncPullResponse = {
                documents,
                checkpoint: {
                    cursor: nextCursor
                }
            }

            return {
                status: 200,
                body: response
            }
        }
    }
}

function parsePullRequest(
    input: unknown,
    args: { defaultBatchSize: number }
) {
    try {
        return parseSyncPullRequest(input, args)
    } catch (error) {
        const standard = wrapProtocolError(error, {
            code: 'INVALID_REQUEST',
            message: 'Invalid sync pull request',
            kind: 'validation'
        })
        const details = toThrowDetails(standard.details)
        throwError(standard.code, standard.message, {
            kind: standard.kind,
            ...(details ? details : {})
        } as any)
    }
}

function toThrowDetails(details: unknown): Record<string, unknown> | undefined {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined
    return details as Record<string, unknown>
}
