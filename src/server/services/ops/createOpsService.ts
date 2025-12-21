import pLimit from 'p-limit'
import { byteLengthUtf8 } from '../../http/body'
import type { AtomaServerConfig, AtomaServerRoute } from '../../config'
import type { OpsService } from '../types'
import type { AuthzPolicy } from '../../policies/authzPolicy'
import type { LimitPolicy } from '../../policies/limitPolicy'
import { throwError, toStandardError } from '../../error'
import { fieldPolicyForResource } from '../../authz/fieldPolicyForResource'
import { mergeForcedWhere } from '../../authz/mergeForcedWhere'
import { enforceQueryFieldPolicy, resolveFieldPolicy } from '../../guard/fieldPolicy'
import { Protocol } from '#protocol'
import type { IOrmAdapter, QueryParams, QueryResult } from '../../types'
import { executeWriteItemWithSemantics } from '../../writeSemantics/executeWriteItemWithSemantics'
import { validateWriteForOp } from '../batchRest/validateWriteForOp'

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

type QueryOp = {
    opId: string
    kind: 'query'
    query: {
        resource: string
        params: QueryParams
    }
}

type WriteAction = 'create' | 'update' | 'patch' | 'delete'

type WriteItemMeta = {
    idempotencyKey?: string
    clientTimeMs?: number
}

type WriteItem =
    | { entityId?: string; value: unknown; meta?: WriteItemMeta } // create
    | { entityId: string; baseVersion: number; value: unknown; meta?: WriteItemMeta } // update
    | { entityId: string; baseVersion: number; patch: unknown[]; meta?: WriteItemMeta } // patch
    | { entityId: string; baseVersion: number; meta?: WriteItemMeta } // delete

type WriteOp = {
    opId: string
    kind: 'write'
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
        return { opId, kind: 'query', query: { resource, params: params as QueryParams } }
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
        if (action !== 'create' && action !== 'update' && action !== 'patch' && action !== 'delete') {
            throwError('INVALID_REQUEST', 'Invalid write.action', { kind: 'validation', opId })
        }
        const items = Array.isArray(value.write.items) ? value.write.items : undefined
        if (!items) {
            throwError('INVALID_REQUEST', 'Missing write.items', { kind: 'validation', opId })
        }
        return {
            opId,
            kind: 'write',
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
        return { opId, kind: 'changes.pull', pull: { cursor, limit, ...(resources ? { resources } : {}) } }
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

function toBatchWriteOp(op: WriteOp) {
    const resource = op.write.resource
    const action = op.write.action
    const items = op.write.items

    if (action === 'create') {
        const payload = items.map((raw: any) => {
            const meta = isObject(raw?.meta) ? raw.meta : undefined
            const idempotencyKey = meta && typeof meta.idempotencyKey === 'string' ? meta.idempotencyKey : undefined
            return {
                data: (raw as any).value,
                ...(idempotencyKey ? { meta: { idempotencyKey } } : {})
            }
        })
        return { opId: op.opId, action: 'bulkCreate', resource, payload }
    }

    if (action === 'update') {
        const payload = items.map((raw: any) => {
            const meta = isObject(raw?.meta) ? raw.meta : undefined
            const idempotencyKey = meta && typeof meta.idempotencyKey === 'string' ? meta.idempotencyKey : undefined
            return {
                id: (raw as any).entityId,
                data: (raw as any).value,
                baseVersion: (raw as any).baseVersion,
                ...(idempotencyKey ? { meta: { idempotencyKey } } : {})
            }
        })
        return { opId: op.opId, action: 'bulkUpdate', resource, payload }
    }

    if (action === 'patch') {
        const payload = items.map((raw: any) => {
            const meta = isObject(raw?.meta) ? raw.meta : undefined
            const idempotencyKey = meta && typeof meta.idempotencyKey === 'string' ? meta.idempotencyKey : undefined
            const timestamp = meta && typeof meta.clientTimeMs === 'number' ? meta.clientTimeMs : undefined
            const jsonPatch = Array.isArray(raw.patch) ? raw.patch : undefined
            if (!jsonPatch) {
                throwError('INVALID_REQUEST', 'Missing patch', { kind: 'validation', opId: op.opId })
            }
            return {
                id: (raw as any).entityId,
                patches: jsonPatchToAtomaPatches(jsonPatch),
                baseVersion: (raw as any).baseVersion,
                ...(timestamp !== undefined ? { timestamp } : {}),
                ...(idempotencyKey ? { meta: { idempotencyKey } } : {})
            }
        })
        return { opId: op.opId, action: 'bulkPatch', resource, payload }
    }

    const payload = items.map((raw: any) => {
        const meta = isObject(raw?.meta) ? raw.meta : undefined
        const idempotencyKey = meta && typeof meta.idempotencyKey === 'string' ? meta.idempotencyKey : undefined
        return {
            id: (raw as any).entityId,
            baseVersion: (raw as any).baseVersion,
            ...(idempotencyKey ? { meta: { idempotencyKey } } : {})
        }
    })
    return { opId: op.opId, action: 'bulkDelete', resource, payload }
}

export function createOpsService<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    authz: AuthzPolicy<Ctx>
    limits: LimitPolicy<Ctx>
    syncEnabled: boolean
}): OpsService<Ctx> {
    const adapter = args.config.adapter.orm as IOrmAdapter
    const syncEnabled = args.syncEnabled === true
    const idempotencyTtlMs = args.config.sync?.push?.idempotencyTtlMs ?? 7 * 24 * 60 * 60 * 1000

    const runItem = async <T>(fn: (args: { orm: IOrmAdapter; tx?: unknown }) => Promise<T>): Promise<T> => {
        if (!syncEnabled) return fn({ orm: adapter, tx: undefined })
        return adapter.transaction(async (tx) => fn({ orm: tx.orm, tx: tx.tx }))
    }

    return {
        handle: async ({ incoming, method, runtime, phase }) => {
            if (method !== 'POST') {
                throwError('METHOD_NOT_ALLOWED', 'POST required', { kind: 'validation', traceId: runtime.traceId, requestId: runtime.requestId })
            }

            const bodyRaw = await args.limits.readBodyJson(incoming)
            const req = normalizeOpsRequest(bodyRaw)
            ensureV1(req.meta)

            const ops = req.ops.map(normalizeOperation)

            const seen = new Set<string>()
            for (const op of ops) {
                if (seen.has(op.opId)) {
                    throwError('INVALID_REQUEST', `Duplicate opId: ${op.opId}`, { kind: 'validation', opId: op.opId })
                }
                seen.add(op.opId)
            }

            await phase.validated({ request: req, event: { opCount: ops.length } })

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

            for (const op of ops) {
                if (op.kind === 'query') {
                    args.authz.ensureResourceAllowed(op.query.resource, { traceId: runtime.traceId, requestId: runtime.requestId })
                }
                if (op.kind === 'write') {
                    args.authz.ensureResourceAllowed(op.write.resource, { traceId: runtime.traceId, requestId: runtime.requestId })
                }
            }

            for (let i = 0; i < queryOps.length; i++) {
                const op = queryOps[i]
                const resource = op.query.resource
                const input = fieldPolicyForResource(args.config, resource)
                const policy = resolveFieldPolicy(input, {
                    action: 'query',
                    resource,
                    params: op.query.params,
                    ctx: runtime.ctx,
                    queryIndex: i
                })
                enforceQueryFieldPolicy(resource, op.query.params, policy, {
                    queryIndex: i,
                    traceId: runtime.traceId,
                    requestId: runtime.requestId,
                    opId: op.opId
                })
            }

            const route: AtomaServerRoute = { kind: 'ops' }

            await Promise.all(ops.map(async (op) => {
                if (op.kind === 'query') {
                    const forced = await args.authz.filterQuery({
                        resource: op.query.resource,
                        params: op.query.params,
                        op,
                        route,
                        runtime
                    })
                    forced.forEach(w => mergeForcedWhere(op.query.params, w))
                    await args.authz.authorize({
                        action: 'query',
                        resource: op.query.resource,
                        op,
                        route,
                        runtime
                    })
                    return
                }

                if (op.kind === 'write') {
                    await args.authz.authorize({
                        action: 'write',
                        resource: op.write.resource,
                        op,
                        route,
                        runtime
                    })

                    const batchWrite = toBatchWriteOp(op)
                    await validateWriteForOp({
                        config: args.config,
                        route,
                        op: batchWrite as any,
                        runtime,
                        authz: args.authz
                    })
                    return
                }
            }))

            await phase.authorized({ event: { queryOps: queryOps.length, writeOps: writeOps.length } })

            const resultsByOpId = new Map<string, OperationResult>()

            if (queryOps.length) {
                const entries = queryOps.map(q => ({ opId: q.opId, resource: q.query.resource, params: q.query.params }))
                let didBatch = false

                if (typeof adapter.batchFindMany === 'function') {
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
                            { traceId: runtime.traceId, requestId: runtime.requestId, opId: e.opId }
                        )
                        resultsByOpId.set(e.opId, { opId: e.opId, ok: false, error: standard })
                    }
                }
            }

            if (writeOps.length) {
                const limit = pLimit(8)

                await Promise.all(writeOps.map(op => limit(async () => {
                    const resource = op.write.resource
                    const action = op.write.action
                    const items = Array.isArray(op.write.items) ? op.write.items : []

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
                                    meta: { traceId: runtime.traceId, requestId: runtime.requestId, opId: op.opId },
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
                                    error: Protocol.error.withTrace(res.error, { traceId: runtime.traceId, requestId: runtime.requestId, opId: op.opId }),
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
                                    meta: { traceId: runtime.traceId, requestId: runtime.requestId, opId: op.opId },
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
                                    error: Protocol.error.withTrace(res.error, { traceId: runtime.traceId, requestId: runtime.requestId, opId: op.opId }),
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
                                    meta: { traceId: runtime.traceId, requestId: runtime.requestId, opId: op.opId },
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
                                    error: Protocol.error.withTrace(res.error, { traceId: runtime.traceId, requestId: runtime.requestId, opId: op.opId }),
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
                                meta: { traceId: runtime.traceId, requestId: runtime.requestId, opId: op.opId },
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
                                error: Protocol.error.withTrace(res.error, { traceId: runtime.traceId, requestId: runtime.requestId, opId: op.opId }),
                                ...(res.replay.currentValue !== undefined || res.replay.currentVersion !== undefined
                                    ? { current: { ...(res.replay.currentValue !== undefined ? { value: res.replay.currentValue } : {}), ...(res.replay.currentVersion !== undefined ? { version: res.replay.currentVersion } : {}) } }
                                    : {})
                            }
                        } catch (err) {
                            const standard = Protocol.error.withTrace(
                                toStandardError(err, 'WRITE_FAILED'),
                                { traceId: runtime.traceId, requestId: runtime.requestId, opId: op.opId }
                            )
                            itemResults[i] = { index: i, ok: false, error: standard }
                        }
                    }

                    const transactionApplied = syncEnabled
                    resultsByOpId.set(op.opId, {
                        opId: op.opId,
                        ok: true,
                        data: { transactionApplied, results: itemResults }
                    })
                })))
            }

            const pullOps = ops.filter((o): o is ChangesPullOp => o.kind === 'changes.pull')
            if (pullOps.length) {
                if (!args.config.adapter.sync) {
                    throwError('INVALID_REQUEST', 'Sync adapter is required for changes.pull', { kind: 'validation' })
                }
            }

            for (const op of pullOps) {
                try {
                    const cursor = parseCursorV1(op.pull.cursor)
                    const maxLimit = args.config.sync?.pull?.maxLimit ?? args.config.limits?.syncPull?.maxLimit ?? 200
                    const limit = Math.min(Math.max(1, Math.floor(op.pull.limit)), maxLimit)

                    const raw = await args.config.adapter.sync!.pullChanges(cursor, limit)
                    const filtered = await args.authz.filterChanges({
                        changes: raw,
                        route: { kind: 'sync', name: 'pull' } as AtomaServerRoute,
                        runtime
                    })

                    const nextCursor = raw.length ? raw[raw.length - 1].cursor : cursor
                    resultsByOpId.set(op.opId, {
                        opId: op.opId,
                        ok: true,
                        data: {
                            nextCursor: String(nextCursor),
                            changes: filtered.map((c: any) => ({
                                resource: c.resource,
                                entityId: c.id,
                                kind: c.kind,
                                version: c.serverVersion,
                                changedAtMs: c.changedAt
                            }))
                        }
                    })
                } catch (err) {
                    const standard = Protocol.error.withTrace(
                        toStandardError(err, 'SYNC_PULL_FAILED'),
                        { traceId: runtime.traceId, requestId: runtime.requestId, opId: op.opId }
                    )
                    resultsByOpId.set(op.opId, { opId: op.opId, ok: false, error: standard })
                }
            }

            const results: OperationResult[] = ops.map((op) => {
                const res = resultsByOpId.get(op.opId)
                if (res) return res
                return {
                    opId: op.opId,
                    ok: false,
                    error: Protocol.error.withTrace(
                        Protocol.error.create('INTERNAL', 'Missing result'),
                        { traceId: runtime.traceId, requestId: runtime.requestId, opId: op.opId }
                    )
                }
            })

            const metaOut = {
                v: 1,
                ...(runtime.traceId ? { traceId: runtime.traceId } : {}),
                ...(runtime.requestId ? { requestId: runtime.requestId } : {}),
                serverTimeMs: Date.now(),
                ...(req.meta.deviceId ? { deviceId: req.meta.deviceId } : {})
            }

            return {
                status: 200,
                body: Protocol.http.compose.ok({ results }, { meta: metaOut })
            }
        }
    }
}
