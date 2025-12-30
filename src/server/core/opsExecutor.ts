import pLimit from 'p-limit'
import { byteLengthUtf8, throwError, toStandardError } from '../error'
import type { AtomaOpPlugin, AtomaOpPluginContext, AtomaOpPluginResult, AtomaServerConfig, AtomaServerRoute } from '../config'
import type { ServerRuntime } from '../runtime/createRuntime'
import { Protocol } from '#protocol'
import type { IOrmAdapter, QueryParams, QueryResult } from '../adapters/ports'
import { executeWriteItemWithSemantics } from './write'

type JsonObject = Record<string, unknown>

type Meta = {
    v: number
    deviceId?: string
    traceId?: string
    requestId?: string
    clientTimeMs?: number
}

type OpsRequest = {
    meta: Meta
    ops: unknown[]
}

type OpMeta = {
    traceId?: string
    requestId?: string
}

type QueryOp = {
    opId: string
    kind: 'query'
    meta?: OpMeta
    query: {
        resource: string
        params: QueryParams
    }
}

type WriteAction = 'create' | 'update' | 'patch' | 'delete' | 'upsert'

type WriteItemMeta = {
    idempotencyKey?: string
    clientTimeMs?: number
}

type WriteItem =
    | { entityId?: string; value: unknown; meta?: WriteItemMeta } // create
    | { entityId: string; baseVersion: number; value: unknown; meta?: WriteItemMeta } // update
    | { entityId: string; baseVersion?: number; value: unknown; meta?: WriteItemMeta } // upsert
    | { entityId: string; baseVersion: number; patch: unknown[]; meta?: WriteItemMeta } // patch
    | { entityId: string; baseVersion: number; meta?: WriteItemMeta } // delete

type WriteOp = {
    opId: string
    kind: 'write'
    meta?: OpMeta
    write: {
        resource: string
        action: WriteAction
        items: WriteItem[]
        options?: unknown
    }
}

type ChangesPullOp = {
    opId: string
    kind: 'changes.pull'
    meta?: OpMeta
    pull: {
        cursor: string
        limit: number
        resources?: string[]
    }
}

type Operation = QueryOp | WriteOp | ChangesPullOp

type OperationResult =
    | { opId: string; ok: true; data: unknown }
    | { opId: string; ok: false; error: unknown }

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readString(obj: JsonObject, key: string): string | undefined {
    const v = obj[key]
    return typeof v === 'string' ? v : undefined
}

function readNumber(obj: JsonObject, key: string): number | undefined {
    const v = obj[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function normalizeMeta(value: unknown): Meta {
    if (!isObject(value)) {
        throwError('INVALID_REQUEST', 'Invalid meta', { kind: 'validation' })
    }
    const v = readNumber(value, 'v')
    if (v === undefined) {
        throwError('INVALID_REQUEST', 'Missing meta.v', { kind: 'validation' })
    }
    const deviceId = readString(value, 'deviceId')
    const traceId = readString(value, 'traceId')
    const requestId = readString(value, 'requestId')
    const clientTimeMs = readNumber(value, 'clientTimeMs')
    return {
        v,
        ...(deviceId ? { deviceId } : {}),
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(clientTimeMs !== undefined ? { clientTimeMs } : {})
    }
}

function normalizeOpsRequest(value: unknown): OpsRequest {
    if (!isObject(value)) {
        throwError('INVALID_REQUEST', 'Invalid body', { kind: 'validation' })
    }
    const meta = normalizeMeta(value.meta)
    const ops = Array.isArray(value.ops) ? value.ops : undefined
    if (!ops) {
        throwError('INVALID_REQUEST', 'Missing ops', { kind: 'validation' })
    }
    return { meta, ops }
}

function normalizeOpMeta(value: unknown): OpMeta | undefined {
    if (!isObject(value)) return undefined
    const traceId = readString(value, 'traceId')
    const requestId = readString(value, 'requestId')
    if (!traceId && !requestId) return undefined
    return { ...(traceId ? { traceId } : {}), ...(requestId ? { requestId } : {}) }
}

function normalizeOperation(value: unknown): Operation {
    if (!isObject(value)) {
        throwError('INVALID_REQUEST', 'Invalid op', { kind: 'validation' })
    }
    const opId = readString(value, 'opId')
    if (!opId) {
        throwError('INVALID_REQUEST', 'Missing opId', { kind: 'validation' })
    }
    const kind = readString(value, 'kind')
    if (!kind) {
        throwError('INVALID_REQUEST', 'Missing kind', { kind: 'validation', opId })
    }

    const meta = normalizeOpMeta((value as any).meta)

    if (kind === 'query') {
        if (!isObject(value.query)) {
            throwError('INVALID_REQUEST', 'Missing query', { kind: 'validation', opId })
        }
        const resource = readString(value.query, 'resource')
        if (!resource) {
            throwError('INVALID_REQUEST', 'Missing query.resource', { kind: 'validation', opId })
        }
        const params = (value.query as any).params
        if (!isObject(params)) {
            throwError('INVALID_REQUEST', 'Missing query.params', { kind: 'validation', opId })
        }
        return { opId, kind: 'query', ...(meta ? { meta } : {}), query: { resource, params: params as QueryParams } }
    }

    if (kind === 'write') {
        if (!isObject(value.write)) {
            throwError('INVALID_REQUEST', 'Missing write', { kind: 'validation', opId })
        }
        const resource = readString(value.write, 'resource')
        if (!resource) {
            throwError('INVALID_REQUEST', 'Missing write.resource', { kind: 'validation', opId })
        }
        const action = readString(value.write, 'action') as WriteAction | undefined
        if (action !== 'create' && action !== 'update' && action !== 'patch' && action !== 'delete' && action !== 'upsert') {
            throwError('INVALID_REQUEST', 'Invalid write.action', { kind: 'validation', opId })
        }
        const items = Array.isArray(value.write.items) ? value.write.items : undefined
        if (!items) {
            throwError('INVALID_REQUEST', 'Missing write.items', { kind: 'validation', opId })
        }
        return {
            opId,
            kind: 'write',
            ...(meta ? { meta } : {}),
            write: { resource, action, items: items as any[], ...(value.write.options !== undefined ? { options: value.write.options } : {}) }
        }
    }

    if (kind === 'changes.pull') {
        if (!isObject(value.pull)) {
            throwError('INVALID_REQUEST', 'Missing pull', { kind: 'validation', opId })
        }
        const cursor = readString(value.pull, 'cursor')
        const limit = readNumber(value.pull, 'limit')
        if (cursor === undefined || limit === undefined) {
            throwError('INVALID_REQUEST', 'Missing pull.cursor or pull.limit', { kind: 'validation', opId })
        }
        const resources = Array.isArray((value.pull as any).resources)
            ? (value.pull as any).resources.filter((r: any) => typeof r === 'string')
            : undefined
        return { opId, kind: 'changes.pull', ...(meta ? { meta } : {}), pull: { cursor, limit, ...(resources ? { resources } : {}) } }
    }

    throwError('INVALID_REQUEST', `Unsupported op kind: ${kind}`, { kind: 'validation', opId })
}

function ensureV1(meta: Meta) {
    if (meta.v === 1) return
    throwError('PROTOCOL_UNSUPPORTED_VERSION', 'Unsupported protocol version', {
        kind: 'validation',
        supported: [1],
        received: meta.v
    })
}

function clampQueryLimit(params: QueryParams, maxLimit: number) {
    const page = params?.page
    if (!page || typeof page !== 'object') return
    if (page.mode === 'offset' || page.mode === 'cursor') {
        if (typeof page.limit === 'number' && page.limit > maxLimit) {
            page.limit = maxLimit
        }
    }
}

function parseCursorV1(cursor: string): number {
    if (!cursor.match(/^[0-9]+$/)) {
        throwError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation' })
    }
    const n = Number(cursor)
    if (!Number.isFinite(n) || n < 0) {
        throwError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation' })
    }
    return n
}

function unescapeJsonPointerSegment(value: string): string {
    return value.replace(/~1/g, '/').replace(/~0/g, '~')
}

function jsonPointerToPath(pointer: string): Array<string | number> {
    if (pointer === '') return []
    if (!pointer.startsWith('/')) {
        throwError('INVALID_REQUEST', 'JSON Pointer path must start with "/" (or be empty for root)', { kind: 'validation' })
    }
    const rawSegments = pointer.split('/').slice(1)
    return rawSegments.map((raw) => {
        const seg = unescapeJsonPointerSegment(raw)
        if (seg.match(/^(0|[1-9][0-9]*)$/)) return Number(seg)
        return seg
    })
}

function jsonPatchToAtomaPatches(patch: unknown[]): any[] {
    return patch.map((raw) => {
        if (!isObject(raw)) {
            throwError('INVALID_REQUEST', 'Invalid patch op', { kind: 'validation' })
        }
        const op = readString(raw, 'op')
        const path = readString(raw, 'path')
        if (!op || path === undefined) {
            throwError('INVALID_REQUEST', 'Missing patch op/path', { kind: 'validation' })
        }
        if (op !== 'add' && op !== 'replace' && op !== 'remove') {
            throwError('INVALID_REQUEST', `Unsupported patch op: ${op}`, { kind: 'validation' })
        }
        const out: any = {
            op,
            path: jsonPointerToPath(path)
        }
        if (op === 'add' || op === 'replace') {
            if (!('value' in raw)) {
                throwError('INVALID_REQUEST', `Missing value for patch op: ${op}`, { kind: 'validation' })
            }
            out.value = (raw as any).value
        }
        return out
    })
}

export type OpsExecutor<Ctx> = {
    handle: (args: {
        incoming: any
        method: string
        pathname: string
        runtime: ServerRuntime<Ctx>
    }) => Promise<{ status: number; body: any; headers?: Record<string, string> }>
}

export function createOpsExecutor<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    readBodyJson: (incoming: any) => Promise<any>
    syncEnabled: boolean
    opPlugins?: AtomaOpPlugin<Ctx>[]
}): OpsExecutor<Ctx> {
    const adapter = args.config.adapter.orm as IOrmAdapter
    const syncEnabled = args.syncEnabled === true
    const idempotencyTtlMs = args.config.sync?.push?.idempotencyTtlMs ?? 7 * 24 * 60 * 60 * 1000
    const opPlugins = Array.isArray(args.opPlugins) ? args.opPlugins : []

    const runItem = async <T>(fn: (args: { orm: IOrmAdapter; tx?: unknown }) => Promise<T>): Promise<T> => {
        if (!syncEnabled) return fn({ orm: adapter, tx: undefined })
        return adapter.transaction(async (tx) => fn({ orm: tx.orm, tx: tx.tx }))
    }

    const runOpPlugins = async (ctx: AtomaOpPluginContext<Ctx>, next: () => Promise<AtomaOpPluginResult>): Promise<AtomaOpPluginResult> => {
        if (!opPlugins.length) return next()

        const dispatch = opPlugins.reduceRight<() => Promise<AtomaOpPluginResult>>(
            (nextFn, plugin) => () => plugin(ctx, nextFn),
            next
        )

        try {
            return await dispatch()
        } catch (err) {
            return { ok: false, error: err }
        }
    }

    return {
        handle: async ({ incoming, method, runtime }) => {
            if (method !== 'POST') {
                throwError('METHOD_NOT_ALLOWED', 'POST required', { kind: 'validation', traceId: runtime.traceId, requestId: runtime.requestId })
            }

            const bodyRaw = await args.readBodyJson(incoming)
            const req = normalizeOpsRequest(bodyRaw)
            ensureV1(req.meta)

            const ops = req.ops.map(normalizeOperation)
            const traceByOpId = new Map<string, { traceId?: string; requestId?: string }>()
            ops.forEach(op => {
                const traceId = (op.meta && typeof op.meta.traceId === 'string' && op.meta.traceId) ? op.meta.traceId : undefined
                const requestId = (op.meta && typeof op.meta.requestId === 'string' && op.meta.requestId) ? op.meta.requestId : undefined
                if (traceId || requestId) traceByOpId.set(op.opId, { traceId, requestId })
            })

            const traceMetaForOpId = (opId: string) => {
                const t = traceByOpId.get(opId)
                return { traceId: t?.traceId, requestId: t?.requestId, opId }
            }

            const seen = new Set<string>()
            for (const op of ops) {
                if (seen.has(op.opId)) {
                    throwError('INVALID_REQUEST', `Duplicate opId: ${op.opId}`, { kind: 'validation', opId: op.opId })
                }
                seen.add(op.opId)
            }

            const limits = args.config.limits
            const queryOps = ops.filter((o): o is QueryOp => o.kind === 'query')
            const writeOps = ops.filter((o): o is WriteOp => o.kind === 'write')

            if (limits?.batch?.maxOps && ops.length > limits.batch.maxOps) {
                throwError('INVALID_REQUEST', `Too many ops: max ${limits.batch.maxOps}`, {
                    kind: 'limits',
                    max: limits.batch.maxOps,
                    actual: ops.length,
                    ...(runtime.traceId ? { traceId: runtime.traceId } : {}),
                    ...(runtime.requestId ? { requestId: runtime.requestId } : {})
                })
            }

            if (limits?.query?.maxQueries && queryOps.length > limits.query.maxQueries) {
                throwError('TOO_MANY_QUERIES', `Too many queries: max ${limits.query.maxQueries}`, {
                    kind: 'limits',
                    max: limits.query.maxQueries,
                    actual: queryOps.length,
                    ...(runtime.traceId ? { traceId: runtime.traceId } : {}),
                    ...(runtime.requestId ? { requestId: runtime.requestId } : {})
                })
            }

            if (limits?.query?.maxLimit) {
                for (const op of queryOps) {
                    clampQueryLimit(op.query.params, limits.query.maxLimit)
                }
            }

            for (const op of writeOps) {
                const items = Array.isArray(op.write.items) ? op.write.items : []
                if (limits?.write?.maxBatchSize && items.length > limits.write.maxBatchSize) {
                    throwError('TOO_MANY_ITEMS', `Too many items: max ${limits.write.maxBatchSize}`, {
                        kind: 'limits',
                        max: limits.write.maxBatchSize,
                        actual: items.length,
                        ...(runtime.traceId ? { traceId: runtime.traceId } : {}),
                        ...(runtime.requestId ? { requestId: runtime.requestId } : {}),
                        opId: op.opId
                    } as any)
                }

                if (limits?.write?.maxPayloadBytes) {
                    const size = byteLengthUtf8(JSON.stringify(items ?? ''))
                    if (size > limits.write.maxPayloadBytes) {
                        throwError('PAYLOAD_TOO_LARGE', `Payload too large: max ${limits.write.maxPayloadBytes} bytes`, {
                            kind: 'limits',
                            max: limits.write.maxPayloadBytes,
                            actual: size,
                            ...(runtime.traceId ? { traceId: runtime.traceId } : {}),
                            ...(runtime.requestId ? { requestId: runtime.requestId } : {}),
                            opId: op.opId
                        } as any)
                    }
                }
            }

            const route: AtomaServerRoute = { kind: 'ops' }

            const resultsByOpId = new Map<string, OperationResult>()
            const pluginRuntime = {
                ctx: runtime.ctx as Ctx,
                traceId: runtime.traceId,
                requestId: runtime.requestId,
                logger: runtime.logger
            }

            if (queryOps.length) {
                const entries = queryOps.map(q => ({ opId: q.opId, resource: q.query.resource, params: q.query.params }))
                const queryOpById = new Map(queryOps.map(q => [q.opId, q] as const))
                let didBatch = false

                if (!opPlugins.length && typeof adapter.batchFindMany === 'function') {
                    try {
                        const resList = await adapter.batchFindMany(entries.map(e => ({ resource: e.resource, params: e.params })))
                        for (let i = 0; i < entries.length; i++) {
                            const e = entries[i]
                            const res = resList[i] as QueryResult | undefined
                            resultsByOpId.set(e.opId, {
                                opId: e.opId,
                                ok: true,
                                data: { items: res?.data ?? [], ...(res?.pageInfo ? { pageInfo: res.pageInfo } : {}) }
                            })
                        }
                        didBatch = true
                    } catch {
                        // fallback to per-query execution to preserve per-op error contract
                    }
                }

                if (!didBatch) {
                    if (!opPlugins.length) {
                        const settled = await Promise.allSettled(entries.map(e => adapter.findMany(e.resource, e.params)))
                        for (let i = 0; i < entries.length; i++) {
                            const e = entries[i]
                            const res = settled[i]
                            if (res.status === 'fulfilled') {
                                resultsByOpId.set(e.opId, {
                                    opId: e.opId,
                                    ok: true,
                                    data: { items: res.value.data, ...(res.value.pageInfo ? { pageInfo: res.value.pageInfo } : {}) }
                                })
                                continue
                            }
                            const standard = Protocol.error.withTrace(
                                toStandardError(res.reason, 'QUERY_FAILED'),
                                traceMetaForOpId(e.opId)
                            )
                            resultsByOpId.set(e.opId, { opId: e.opId, ok: false, error: standard })
                        }
                    } else {
                        await Promise.all(entries.map(async (e) => {
                            const op = queryOpById.get(e.opId)
                            const pluginResult = await runOpPlugins({
                                opId: e.opId,
                                kind: 'query',
                                resource: e.resource,
                                op,
                                route,
                                runtime: pluginRuntime
                            }, async () => {
                                try {
                                    const res = await adapter.findMany(e.resource, e.params)
                                    return { ok: true, data: { items: res.data, ...(res.pageInfo ? { pageInfo: res.pageInfo } : {}) } }
                                } catch (err) {
                                    return { ok: false, error: err }
                                }
                            })

                            if (pluginResult.ok) {
                                resultsByOpId.set(e.opId, { opId: e.opId, ok: true, data: pluginResult.data })
                                return
                            }

                            const standard = Protocol.error.withTrace(
                                toStandardError(pluginResult.error, 'QUERY_FAILED'),
                                traceMetaForOpId(e.opId)
                            )
                            resultsByOpId.set(e.opId, { opId: e.opId, ok: false, error: standard })
                        }))
                    }
                }
            }

            if (writeOps.length) {
                const limit = pLimit(8)

                await Promise.all(writeOps.map(op => limit(async () => {
                    const opTrace = traceMetaForOpId(op.opId)
                    const resource = op.write.resource
                    const action = op.write.action
                    const items = Array.isArray(op.write.items) ? op.write.items : []

                    const pluginResult = await runOpPlugins({
                        opId: op.opId,
                        kind: 'write',
                        resource,
                        op,
                        route,
                        runtime: pluginRuntime
                    }, async () => {
                        const itemResults: any[] = new Array(items.length)

                        for (let i = 0; i < items.length; i++) {
                            const raw = items[i] as any
                            const meta = isObject(raw?.meta) ? raw.meta : undefined
                            const idempotencyKey = meta && typeof meta.idempotencyKey === 'string' ? meta.idempotencyKey : undefined
                            const timestamp = meta && typeof meta.clientTimeMs === 'number' ? meta.clientTimeMs : undefined

                            try {
                                if (action === 'create') {
                                    const res = await runItem(({ orm, tx }) => executeWriteItemWithSemantics({
                                        orm,
                                        sync: args.config.adapter.sync,
                                        tx,
                                        syncEnabled,
                                        idempotencyTtlMs,
                                        meta: opTrace,
                                        write: {
                                            kind: 'create',
                                            resource,
                                            ...(idempotencyKey ? { idempotencyKey } : {}),
                                            data: raw?.value
                                        }
                                    }))

                                    if (res.ok) {
                                        itemResults[i] = {
                                            index: i,
                                            ok: true,
                                            entityId: res.replay.id,
                                            version: res.replay.serverVersion,
                                            ...(res.data !== undefined ? { data: res.data } : {})
                                        }
                                        continue
                                    }

                                    itemResults[i] = {
                                        index: i,
                                        ok: false,
                                        error: Protocol.error.withTrace(res.error, opTrace),
                                        ...(res.replay.currentValue !== undefined || res.replay.currentVersion !== undefined
                                            ? { current: { ...(res.replay.currentValue !== undefined ? { value: res.replay.currentValue } : {}), ...(res.replay.currentVersion !== undefined ? { version: res.replay.currentVersion } : {}) } }
                                            : {})
                                    }
                                    continue
                                }

                                if (action === 'update') {
                                    const entityId = raw?.entityId
                                    const baseVersion = raw?.baseVersion
                                    const full = (raw?.value && typeof raw.value === 'object') ? { ...raw.value, id: entityId } : { id: entityId }
                                    const patches = [{ op: 'replace', path: [entityId], value: full }]

                                    const res = await runItem(({ orm, tx }) => executeWriteItemWithSemantics({
                                        orm,
                                        sync: args.config.adapter.sync,
                                        tx,
                                        syncEnabled,
                                        idempotencyTtlMs,
                                        meta: opTrace,
                                        write: {
                                            kind: 'patch',
                                            resource,
                                            ...(idempotencyKey ? { idempotencyKey } : {}),
                                            id: entityId,
                                            patches,
                                            baseVersion
                                        }
                                    }))

                                    if (res.ok) {
                                        itemResults[i] = {
                                            index: i,
                                            ok: true,
                                            entityId: res.replay.id,
                                            version: res.replay.serverVersion,
                                            ...(res.data !== undefined ? { data: res.data } : {})
                                        }
                                        continue
                                    }

                                    itemResults[i] = {
                                        index: i,
                                        ok: false,
                                        error: Protocol.error.withTrace(res.error, opTrace),
                                        ...(res.replay.currentValue !== undefined || res.replay.currentVersion !== undefined
                                            ? { current: { ...(res.replay.currentValue !== undefined ? { value: res.replay.currentValue } : {}), ...(res.replay.currentVersion !== undefined ? { version: res.replay.currentVersion } : {}) } }
                                            : {})
                                    }
                                    continue
                                }

                                if (action === 'upsert') {
                                    const entityId = raw?.entityId
                                    const baseVersion = raw?.baseVersion
                                    const value = raw?.value

                                    const res = await runItem(({ orm, tx }) => executeWriteItemWithSemantics({
                                        orm,
                                        sync: args.config.adapter.sync,
                                        tx,
                                        syncEnabled,
                                        idempotencyTtlMs,
                                        meta: opTrace,
                                        write: {
                                            kind: 'upsert',
                                            resource,
                                            ...(idempotencyKey ? { idempotencyKey } : {}),
                                            id: entityId,
                                            baseVersion,
                                            data: value,
                                            ...(timestamp !== undefined ? { timestamp } : {}),
                                            ...(op.write.options !== undefined ? { options: op.write.options as any } : {})
                                        }
                                    }))

                                    if (res.ok) {
                                        itemResults[i] = {
                                            index: i,
                                            ok: true,
                                            entityId: res.replay.id,
                                            version: res.replay.serverVersion,
                                            ...(res.data !== undefined ? { data: res.data } : {})
                                        }
                                        continue
                                    }

                                    itemResults[i] = {
                                        index: i,
                                        ok: false,
                                        error: Protocol.error.withTrace(res.error, opTrace),
                                        ...(res.replay.currentValue !== undefined || res.replay.currentVersion !== undefined
                                            ? { current: { ...(res.replay.currentValue !== undefined ? { value: res.replay.currentValue } : {}), ...(res.replay.currentVersion !== undefined ? { version: res.replay.currentVersion } : {}) } }
                                            : {})
                                    }
                                    continue
                                }

                                if (action === 'patch') {
                                    const entityId = raw?.entityId
                                    const baseVersion = raw?.baseVersion
                                    const jsonPatch = Array.isArray(raw?.patch) ? raw.patch : undefined
                                    if (!jsonPatch) {
                                        throwError('INVALID_REQUEST', 'Missing patch', { kind: 'validation', opId: op.opId })
                                    }
                                    const patches = jsonPatchToAtomaPatches(jsonPatch)

                                    const res = await runItem(({ orm, tx }) => executeWriteItemWithSemantics({
                                        orm,
                                        sync: args.config.adapter.sync,
                                        tx,
                                        syncEnabled,
                                        idempotencyTtlMs,
                                        meta: opTrace,
                                        write: {
                                            kind: 'patch',
                                            resource,
                                            ...(idempotencyKey ? { idempotencyKey } : {}),
                                            id: entityId,
                                            patches,
                                            baseVersion,
                                            ...(timestamp !== undefined ? { timestamp } : {})
                                        }
                                    }))

                                    if (res.ok) {
                                        const id = res.replay.id
                                        const version = res.replay.serverVersion
                                        itemResults[i] = {
                                            index: i,
                                            ok: true,
                                            entityId: id,
                                            version,
                                            ...(res.data !== undefined ? { data: res.data } : {})
                                        }
                                        continue
                                    }

                                    itemResults[i] = {
                                        index: i,
                                        ok: false,
                                        error: Protocol.error.withTrace(res.error, opTrace),
                                        ...(res.replay.currentValue !== undefined || res.replay.currentVersion !== undefined
                                            ? { current: { ...(res.replay.currentValue !== undefined ? { value: res.replay.currentValue } : {}), ...(res.replay.currentVersion !== undefined ? { version: res.replay.currentVersion } : {}) } }
                                            : {})
                                    }
                                    continue
                                }

                                const entityId = raw?.entityId
                                const baseVersion = raw?.baseVersion
                                const res = await runItem(({ orm, tx }) => executeWriteItemWithSemantics({
                                    orm,
                                    sync: args.config.adapter.sync,
                                    tx,
                                    syncEnabled,
                                    idempotencyTtlMs,
                                    meta: opTrace,
                                    write: {
                                        kind: 'delete',
                                        resource,
                                        ...(idempotencyKey ? { idempotencyKey } : {}),
                                        id: entityId,
                                        baseVersion
                                    }
                                }))

                                if (res.ok) {
                                    itemResults[i] = {
                                        index: i,
                                        ok: true,
                                        entityId: res.replay.id,
                                        version: res.replay.serverVersion,
                                        ...(res.data !== undefined ? { data: res.data } : {})
                                    }
                                    continue
                                }

                                itemResults[i] = {
                                    index: i,
                                    ok: false,
                                    error: Protocol.error.withTrace(res.error, opTrace),
                                    ...(res.replay.currentValue !== undefined || res.replay.currentVersion !== undefined
                                        ? { current: { ...(res.replay.currentValue !== undefined ? { value: res.replay.currentValue } : {}), ...(res.replay.currentVersion !== undefined ? { version: res.replay.currentVersion } : {}) } }
                                        : {})
                                }
                            } catch (err) {
                                const standard = Protocol.error.withTrace(
                                    toStandardError(err, 'WRITE_FAILED'),
                                    opTrace
                                )
                                itemResults[i] = { index: i, ok: false, error: standard }
                            }
                        }

                        const transactionApplied = syncEnabled
                        return { ok: true, data: { transactionApplied, results: itemResults } }
                    })

                    if (pluginResult.ok) {
                        resultsByOpId.set(op.opId, {
                            opId: op.opId,
                            ok: true,
                            data: pluginResult.data
                        })
                        return
                    }

                    const standard = Protocol.error.withTrace(
                        toStandardError(pluginResult.error, 'WRITE_FAILED'),
                        opTrace
                    )
                    resultsByOpId.set(op.opId, { opId: op.opId, ok: false, error: standard })
                })))
            }

            const pullOps = ops.filter((o): o is ChangesPullOp => o.kind === 'changes.pull')
            if (pullOps.length) {
                if (!args.config.adapter.sync) {
                    throwError('INVALID_REQUEST', 'Sync adapter is required for changes.pull', { kind: 'validation' })
                }
            }

            for (const op of pullOps) {
                const opTrace = traceMetaForOpId(op.opId)
                const pluginResult = await runOpPlugins({
                    opId: op.opId,
                    kind: 'changes.pull',
                    op,
                    route,
                    runtime: pluginRuntime
                }, async () => {
                    try {
                        const cursor = parseCursorV1(op.pull.cursor)
                        const maxLimit = args.config.sync?.pull?.maxLimit ?? args.config.limits?.syncPull?.maxLimit ?? 200
                        const limit = Math.min(Math.max(1, Math.floor(op.pull.limit)), maxLimit)

                        const raw = await args.config.adapter.sync!.pullChanges(cursor, limit)
                        const nextCursor = raw.length ? raw[raw.length - 1].cursor : cursor
                        return {
                            ok: true,
                            data: {
                                nextCursor: String(nextCursor),
                                changes: raw.map((c: any) => ({
                                    resource: c.resource,
                                    entityId: c.id,
                                    kind: c.kind,
                                    version: c.serverVersion,
                                    changedAtMs: c.changedAt
                                }))
                            }
                        }
                    } catch (err) {
                        return { ok: false, error: err }
                    }
                })

                if (pluginResult.ok) {
                    resultsByOpId.set(op.opId, { opId: op.opId, ok: true, data: pluginResult.data })
                    continue
                }

                const standard = Protocol.error.withTrace(
                    toStandardError(pluginResult.error, 'SYNC_PULL_FAILED'),
                    opTrace
                )
                resultsByOpId.set(op.opId, { opId: op.opId, ok: false, error: standard })
            }

            const results: OperationResult[] = ops.map((op) => {
                const res = resultsByOpId.get(op.opId)
                if (res) return res
                return {
                    opId: op.opId,
                    ok: false,
                    error: Protocol.error.withTrace(
                        Protocol.error.create('INTERNAL', 'Missing result'),
                        traceMetaForOpId(op.opId)
                    )
                }
            })

            const metaOut = {
                v: 1,
                serverTimeMs: Date.now(),
                ...(req.meta.deviceId ? { deviceId: req.meta.deviceId } : {})
            }

            return {
                status: 200,
                body: Protocol.ops.compose.ok({ results }, metaOut)
            }
        }
    }
}
