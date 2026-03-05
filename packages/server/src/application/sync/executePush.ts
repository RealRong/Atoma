import type { SyncDocument, SyncPushResponse } from 'atoma-types/sync'
import { readPushIdempotencyKey } from 'atoma-types/protocol-tools'
import type { AtomaServerConfig } from '../../config'
import type { HandleResult } from '../../runtime/http'
import { throwError } from '../../error'
import { executeWriteItem } from '../../domain/write/executeWriteItem'
import { parseSyncPushRequestOrThrow, throwFromStandardError } from '../../domain/contracts/syncRxdb'

type PushRuntime<Ctx> = {
    requestId: string
    traceId?: string
    logger: any
    ctx: Ctx
}

export async function executeApplicationPush<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    readBodyJson: (incoming: unknown) => Promise<unknown>
    incoming: unknown
    method: string
    runtime: PushRuntime<Ctx>
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

    const request = parseSyncPushRequestOrThrow(await args.readBodyJson(args.incoming))
    const maxBatchSize = Math.max(1, Math.floor(args.config.sync?.push?.maxBatchSize ?? 200))
    if (request.rows.length > maxBatchSize) {
        throwError('TOO_MANY_ITEMS', `Too many sync rows: max ${maxBatchSize}`, {
            kind: 'limits',
            max: maxBatchSize,
            actual: request.rows.length
        })
    }

    const idempotencyTtlMs = args.config.sync?.push?.idempotencyTtlMs ?? 7 * 24 * 60 * 60 * 1000
    const resource = String(request.resource)
    const conflicts: SyncDocument[] = []

    for (let index = 0; index < request.rows.length; index += 1) {
        const row = request.rows[index]!
        const newState = row.newDocumentState as Record<string, unknown>
        const assumed = row.assumedMasterState as Record<string, unknown> | null | undefined

        const id = String((newState as any)?.id ?? '')
        if (!id) continue

        const deleted = Boolean((newState as any)?._deleted === true)
        const assumedVersion = readVersion((assumed as any)?.version)
        const idempotencyKey = readPushIdempotencyKey(row)

        if (deleted && assumedVersion === undefined) {
            continue
        }

        const writeKind = deleted
            ? 'delete'
            : (assumedVersion === undefined ? 'create' : 'update')

        const result = await executeWriteItem({
            orm: args.config.adapter.orm,
            sync,
            syncEnabled: true,
            idempotencyTtlMs,
            logger: args.runtime.logger,
            meta: {
                traceId: request.context?.traceId ?? args.runtime.traceId,
                requestId: request.context?.requestId ?? args.runtime.requestId,
                opId: `sync-rxdb-push:${index}`
            },
            write: {
                kind: writeKind,
                resource,
                id,
                ...(writeKind === 'delete'
                    ? { baseVersion: assumedVersion! }
                    : { data: toWriteData(newState) }),
                ...(writeKind === 'update'
                    ? { baseVersion: assumedVersion! }
                    : {}),
                ...(idempotencyKey ? { idempotencyKey } : {})
            }
        })

        if (result.ok) continue

        if (result.error.kind !== 'conflict' && result.error.code !== 'CONFLICT') {
            throwFromStandardError(result.error)
        }

        conflicts.push(await resolveConflictDocument({
            config: args.config,
            resource,
            id,
            failedResult: result,
            fallbackVersion: assumedVersion ?? readVersion((newState as any)?.version) ?? 1
        }))
    }

    const response: SyncPushResponse = { conflicts }
    return {
        status: 200,
        body: response
    }
}

async function resolveConflictDocument<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    resource: string
    id: string
    failedResult: Extract<Awaited<ReturnType<typeof executeWriteItem>>, { ok: false }>
    fallbackVersion: number
}): Promise<SyncDocument> {
    const replay = args.failedResult.replay
    const replayValue = replay.currentValue
    const replayVersion = readVersion(replay.currentVersion)
    if (replayValue && typeof replayValue === 'object' && !Array.isArray(replayValue)) {
        return {
            ...(replayValue as any),
            id: args.id,
            version: replayVersion
                ?? readVersion((replayValue as any).version)
                ?? Math.max(1, Math.floor(args.fallbackVersion))
        }
    }

    const found = await args.config.adapter.orm.findMany(args.resource, {
        filter: { op: 'eq', field: 'id', value: args.id },
        page: { mode: 'offset', limit: 1 }
    })
    const current = Array.isArray(found.data) ? found.data[0] : undefined
    if (current && typeof current === 'object') {
        return {
            ...(current as any),
            id: args.id,
            version: readVersion((current as any).version)
                ?? Math.max(1, Math.floor(args.fallbackVersion))
        }
    }

    return {
        id: args.id,
        version: Math.max(1, Math.floor(args.fallbackVersion)),
        _deleted: true
    }
}

function toWriteData(newDocumentState: Record<string, unknown>): Record<string, unknown> {
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(newDocumentState)) {
        if (key === 'id' || key === 'version' || key === '_deleted' || key === 'atomaSync') continue
        next[key] = value
    }
    return next
}

function readVersion(value: unknown): number | undefined {
    const version = Number(value)
    if (!Number.isFinite(version)) return undefined
    if (version <= 0) return undefined
    return Math.floor(version)
}
