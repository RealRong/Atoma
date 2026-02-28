import type { SyncDocument, SyncPullResponse } from 'atoma-types/sync'
import type { AtomaServerConfig } from '../../config'
import type { HandleResult } from '../../runtime/http'
import { throwError } from '../../error'
import { parseSyncPullRequestOrThrow } from '../../domain/contracts/syncRxdb'

type PullRuntime<Ctx> = {
    requestId: string
    traceId?: string
    logger: any
    ctx: Ctx
}

export async function executeApplicationPull<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    readBodyJson: (incoming: unknown) => Promise<unknown>
    incoming: unknown
    method: string
    runtime: PullRuntime<Ctx>
}): Promise<HandleResult> {
    if (args.method !== 'POST') {
        throwError('METHOD_NOT_ALLOWED', 'POST required', {
            kind: 'validation',
            traceId: args.runtime.traceId,
            requestId: args.runtime.requestId
        })
    }

    const sync = args.config.adapter.sync
    if (!sync || args.config.sync?.enabled === false) {
        throwError('INVALID_REQUEST', 'Sync adapter is required when sync is enabled', {
            kind: 'validation',
            traceId: args.runtime.traceId,
            requestId: args.runtime.requestId
        })
    }

    const defaultBatchSize = args.config.sync?.pull?.defaultBatchSize ?? 200
    const maxBatchSize = args.config.sync?.pull?.maxBatchSize ?? 500
    const request = parseSyncPullRequestOrThrow(
        await args.readBodyJson(args.incoming),
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

    const documents: SyncDocument[] = latestChanges.map(change => {
        const id = String(change.id)
        if (change.kind === 'delete') {
            return {
                id,
                version: Math.max(1, Math.floor(change.serverVersion)),
                _deleted: true,
                atomaSync: { resource }
            }
        }

        const current = entityById.get(id)
        if (!current || typeof current !== 'object') {
            return {
                id,
                version: Math.max(1, Math.floor(change.serverVersion)),
                _deleted: true,
                atomaSync: { resource }
            }
        }

        const version = Number((current as any).version)
        return {
            ...(current as any),
            id,
            version: Number.isFinite(version) && version > 0
                ? Math.floor(version)
                : Math.max(1, Math.floor(change.serverVersion)),
            atomaSync: { resource }
        } as SyncDocument
    })

    const response: SyncPullResponse = {
        documents,
        checkpoint: { cursor: nextCursor }
    }

    return {
        status: 200,
        body: response
    }
}
