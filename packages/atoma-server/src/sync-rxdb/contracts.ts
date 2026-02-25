import { parseOrThrow, z } from 'atoma-shared'
import type {
    SyncPullRequest,
    SyncPushRequest,
    SyncPushRow
} from 'atoma-types/sync'

const nonEmptyString = z.string().trim().min(1)
const nonNegativeInt = z.number().int().min(0)

const syncDocumentSchema = z.object({
    id: nonEmptyString,
    version: nonNegativeInt,
    _deleted: z.boolean().optional()
}).passthrough()

const syncPushRowSchema = z.object({
    newDocumentState: syncDocumentSchema,
    assumedMasterState: syncDocumentSchema.nullish()
}).passthrough()

export function parseSyncPullRequest(value: unknown, args: {
    defaultBatchSize: number
}): SyncPullRequest {
    const defaultBatchSize = Math.max(1, Math.floor(args.defaultBatchSize))
    return parseOrThrow(
        z.object({
            resource: nonEmptyString,
            checkpoint: z.object({
                cursor: nonNegativeInt
            }).optional(),
            batchSize: nonNegativeInt.optional()
        }).transform((input) => ({
            resource: input.resource,
            checkpoint: input.checkpoint,
            batchSize: Math.max(1, Math.floor(input.batchSize ?? defaultBatchSize))
        })),
        value,
        { prefix: '[SyncRxdbPull]' }
    ) as SyncPullRequest
}

export function parseSyncPushRequest(value: unknown): SyncPushRequest {
    return parseOrThrow(
        z.object({
            resource: nonEmptyString,
            rows: z.array(syncPushRowSchema).default([]),
            context: z.object({
                clientId: nonEmptyString.optional(),
                requestId: nonEmptyString.optional(),
                traceId: nonEmptyString.optional()
            }).optional()
        }),
        value,
        { prefix: '[SyncRxdbPush]' }
    ) as SyncPushRequest
}

export function parseSyncStreamQuery(urlObj: URL): {
    resources?: string[]
    afterCursorByResource: Record<string, number>
    traceId?: string
    requestId?: string
} {
    const resources = normalizeResources(urlObj)
    const afterCursorByResource: Record<string, number> = {}

    const globalCursor = parseCursorValue(urlObj.searchParams.get('cursor'))
    if (globalCursor !== undefined && resources?.length) {
        for (const resource of resources) {
            afterCursorByResource[resource] = globalCursor
        }
    }

    for (const [key, value] of urlObj.searchParams.entries()) {
        if (!key.startsWith('cursor.')) continue
        const resource = key.slice('cursor.'.length).trim()
        if (!resource) continue
        const cursor = parseCursorValue(value)
        if (cursor === undefined) continue
        afterCursorByResource[resource] = cursor
    }

    const traceId = normalizeNonEmpty(urlObj.searchParams.get('traceId'))
    const requestId = normalizeNonEmpty(urlObj.searchParams.get('requestId'))

    return {
        ...(resources?.length ? { resources } : {}),
        afterCursorByResource,
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {})
    }
}

function normalizeResources(urlObj: URL): string[] | undefined {
    const candidates: string[] = []

    const append = (value: string | null) => {
        if (typeof value !== 'string') return
        for (const item of value.split(',')) {
            const normalized = item.trim()
            if (!normalized) continue
            candidates.push(normalized)
        }
    }

    for (const value of urlObj.searchParams.getAll('resources')) {
        append(value)
    }
    for (const value of urlObj.searchParams.getAll('resource')) {
        append(value)
    }

    if (!candidates.length) return undefined
    return Array.from(new Set(candidates))
}

function parseCursorValue(value: string | null | undefined): number | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined
    const number = Number(value)
    if (!Number.isFinite(number)) return undefined
    if (number < 0) return undefined
    return Math.floor(number)
}

function normalizeNonEmpty(value: string | null): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized ? normalized : undefined
}

export function readPushIdempotencyKey(row: SyncPushRow): string | undefined {
    const meta = (row.newDocumentState as any)?.atomaSync
    if (!meta || typeof meta !== 'object') return undefined
    const idempotencyKey = (meta as any).idempotencyKey
    return typeof idempotencyKey === 'string' && idempotencyKey
        ? idempotencyKey
        : undefined
}

export function readPushTimestamp(row: SyncPushRow): number | undefined {
    const meta = (row.newDocumentState as any)?.atomaSync
    if (!meta || typeof meta !== 'object') return undefined
    const changedAtMs = (meta as any).changedAtMs
    return typeof changedAtMs === 'number' && Number.isFinite(changedAtMs)
        ? changedAtMs
        : undefined
}
