import type {
    SyncDocument,
    SyncPullRequest,
    SyncPushRequest,
    SyncPushRow
} from 'atoma-types/sync'

type AnyRecord = Record<string, unknown>

function asObject(value: unknown, label: string): AnyRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 必须是对象`)
    }
    return value as AnyRecord
}

function asNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} 必须是非空字符串`)
    }
    return value.trim()
}

function asOptionalNonEmptyString(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined
    return asNonEmptyString(value, label)
}

function asNonNegativeInt(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.floor(value) !== value) {
        throw new Error(`${label} 必须是非负整数`)
    }
    return value
}

function parseSyncDocument(value: unknown, label: string): SyncDocument {
    const input = asObject(value, label)
    const id = asNonEmptyString(input.id, `${label}.id`)
    const version = asNonNegativeInt(input.version, `${label}.version`)
    const deleted = input._deleted
    if (deleted !== undefined && typeof deleted !== 'boolean') {
        throw new Error(`${label}._deleted 必须是布尔值`)
    }

    return {
        ...input,
        id,
        version,
        ...(deleted === undefined ? {} : { _deleted: deleted })
    }
}

function parseSyncPushRow(value: unknown, label: string): SyncPushRow {
    const input = asObject(value, label)
    const assumedMasterState = input.assumedMasterState

    if (assumedMasterState === undefined) {
        return {
            ...input,
            newDocumentState: parseSyncDocument(input.newDocumentState, `${label}.newDocumentState`)
        }
    }

    if (assumedMasterState === null) {
        return {
            ...input,
            newDocumentState: parseSyncDocument(input.newDocumentState, `${label}.newDocumentState`),
            assumedMasterState: null
        }
    }

    return {
        ...input,
        newDocumentState: parseSyncDocument(input.newDocumentState, `${label}.newDocumentState`),
        assumedMasterState: parseSyncDocument(assumedMasterState, `${label}.assumedMasterState`)
    }
}

export function parseSyncPullRequest(value: unknown, args: {
    defaultBatchSize: number
}): SyncPullRequest {
    const defaultBatchSize = Math.max(1, Math.floor(args.defaultBatchSize))
    const input = asObject(value, '[SyncRxdbPull]')

    const resource = asNonEmptyString(input.resource, '[SyncRxdbPull].resource')
    const checkpointInput = input.checkpoint
    const batchSizeInput = input.batchSize

    const checkpoint = checkpointInput === undefined
        ? undefined
        : {
            cursor: asNonNegativeInt(asObject(checkpointInput, '[SyncRxdbPull].checkpoint').cursor, '[SyncRxdbPull].checkpoint.cursor')
        }

    const batchSize = batchSizeInput === undefined
        ? defaultBatchSize
        : Math.max(1, asNonNegativeInt(batchSizeInput, '[SyncRxdbPull].batchSize'))

    return {
        resource,
        ...(checkpoint ? { checkpoint } : {}),
        batchSize
    }
}

export function parseSyncPushRequest(value: unknown): SyncPushRequest {
    const input = asObject(value, '[SyncRxdbPush]')
    const resource = asNonEmptyString(input.resource, '[SyncRxdbPush].resource')

    const rowsInput = input.rows
    if (rowsInput !== undefined && !Array.isArray(rowsInput)) {
        throw new Error('[SyncRxdbPush].rows 必须是数组')
    }
    const rows = (rowsInput ?? []).map((row, index) => parseSyncPushRow(row, `[SyncRxdbPush].rows[${index}]`))

    const contextInput = input.context
    const context = contextInput === undefined
        ? undefined
        : (() => {
            const contextObject = asObject(contextInput, '[SyncRxdbPush].context')
            const clientId = asOptionalNonEmptyString(contextObject.clientId, '[SyncRxdbPush].context.clientId')
            const requestId = asOptionalNonEmptyString(contextObject.requestId, '[SyncRxdbPush].context.requestId')
            const traceId = asOptionalNonEmptyString(contextObject.traceId, '[SyncRxdbPush].context.traceId')
            return {
                ...(clientId ? { clientId } : {}),
                ...(requestId ? { requestId } : {}),
                ...(traceId ? { traceId } : {})
            }
        })()

    return {
        resource,
        rows,
        ...(context ? { context } : {})
    }
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
