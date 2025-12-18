import pLimit from 'p-limit'
import type { BatchOp, BatchRequest, BatchResponse, BatchResult, IOrmAdapter } from '../types'
import { toStandardError } from '../error'
import type { ISyncAdapter } from '../sync/types'
import { executeWriteItemWithSemantics } from '../writeSemantics/executeWriteItemWithSemantics'

export async function executeRequest(
    request: BatchRequest,
    adapter: { orm: IOrmAdapter; sync?: ISyncAdapter },
    options?: {
        syncEnabled?: boolean
        idempotencyTtlMs?: number
    }
): Promise<BatchResponse> {
    const ops = Array.isArray(request.ops) ? request.ops : []
    const results: BatchResult[] = new Array(ops.length)
    const traceMeta = { traceId: request.traceId, requestId: request.requestId }
    const syncEnabled = options?.syncEnabled === true

    const queryEntries: Array<{ index: number; op: Extract<BatchOp, { action: 'query' }> }> = []
    const writeEntries: Array<{ index: number; op: Exclude<BatchOp, { action: 'query' }> }> = []

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i]
        if (op.action === 'query') queryEntries.push({ index: i, op })
        else writeEntries.push({ index: i, op })
    }

    await Promise.all([
        executeQueries(queryEntries, adapter.orm, results, traceMeta),
        executeWrites(writeEntries, adapter, results, traceMeta, { syncEnabled, idempotencyTtlMs: options?.idempotencyTtlMs })
    ])

    return { results }
}

async function executeQueries(
    entries: Array<{ index: number; op: Extract<BatchOp, { action: 'query' }> }>,
    adapter: IOrmAdapter,
    out: BatchResult[],
    meta: { traceId?: string; requestId?: string }
) {
    if (!entries.length) return

    if (typeof adapter.batchFindMany === 'function') {
        try {
            const resList = await adapter.batchFindMany(entries.map(e => ({
                resource: e.op.query.resource,
                params: e.op.query.params
            })))
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i]
                const res = resList[i]
                out[e.index] = {
                    opId: e.op.opId,
                    ok: true,
                    data: res?.data ?? [],
                    pageInfo: res?.pageInfo
                }
            }
            return
        } catch {
            // fallback to per-query execution to preserve per-op error contract
        }
    }

    const settled = await Promise.allSettled(entries.map(e => adapter.findMany(e.op.query.resource, e.op.query.params)))
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        const res = settled[i]
        if (res.status === 'fulfilled') {
            out[e.index] = { opId: e.op.opId, ok: true, data: res.value.data, pageInfo: res.value.pageInfo }
            continue
        }
        out[e.index] = {
            opId: e.op.opId,
            ok: false,
            error: withTrace(toStandardError(res.reason, 'QUERY_FAILED'), { ...meta, opId: e.op.opId })
        }
    }
}

async function executeWrites(
    entries: Array<{ index: number; op: Exclude<BatchOp, { action: 'query' }> }>,
    adapter: { orm: IOrmAdapter; sync?: ISyncAdapter },
    out: BatchResult[],
    meta: { traceId?: string; requestId?: string },
    options: { syncEnabled: boolean; idempotencyTtlMs?: number }
) {
    if (!entries.length) return

    const limit = pLimit(8)

    const settled = await Promise.allSettled(entries.map(e => limit(async () => {
        const op = e.op
        try {
            switch (op.action) {
                case 'bulkCreate': {
                    if (typeof adapter.orm.create !== 'function' && typeof (adapter.orm as any).bulkCreate !== 'function') {
                        out[e.index] = adapterNotImplemented(op.opId, op.action)
                        return
                    }
                    out[e.index] = await executeBulkCreate(op, adapter, meta, options)
                    return
                }
                case 'bulkUpdate': {
                    // 最优语义：update 统一走 patch（replace root），并强制 baseVersion
                    if (typeof adapter.orm.patch !== 'function') {
                        out[e.index] = adapterNotImplemented(op.opId, op.action)
                        return
                    }
                    out[e.index] = await executeBulkUpdateAsPatch(op, adapter, meta, options)
                    return
                }
                case 'bulkPatch': {
                    if (typeof adapter.orm.patch !== 'function') {
                        out[e.index] = adapterNotImplemented(op.opId, op.action)
                        return
                    }
                    out[e.index] = await executeBulkPatch(op, adapter, meta, options)
                    return
                }
                case 'bulkDelete': {
                    if (typeof adapter.orm.delete !== 'function') {
                        out[e.index] = adapterNotImplemented(op.opId, op.action)
                        return
                    }
                    out[e.index] = await executeBulkDelete(op, adapter, meta, options)
                    return
                }
            }
        } catch (err) {
            out[e.index] = {
                opId: op.opId,
                ok: false,
                error: withTrace(toStandardError(err, 'WRITE_FAILED'), { ...meta, opId: op.opId })
            }
        }
    })))

    // Should never happen (we write into out in the limited function), but keep it safe.
    settled.forEach((r, i) => {
        if (r.status === 'rejected') {
            const e = entries[i]
            out[e.index] = {
                opId: e.op.opId,
                ok: false,
                error: withTrace(toStandardError(r.reason, 'WRITE_FAILED'), { ...meta, opId: e.op.opId })
            }
        }
    })
}

function adapterNotImplemented(opId: string, action: string): BatchResult {
    return {
        opId,
        ok: false,
        error: {
            code: 'ADAPTER_NOT_IMPLEMENTED',
            message: `Adapter does not implement ${action}`,
            details: { kind: 'adapter' }
        }
    }
}

function wrapMany(opId: string, result: any, meta?: { traceId?: string; requestId?: string }): BatchResult {
    const partialFailures = Array.isArray(result?.partialFailures)
        ? result.partialFailures.map((pf: any) => ({
            index: pf.index,
            error: withTrace(toStandardError(pf.error, pf.error?.code), { ...meta, opId })
        }))
        : undefined

    return {
        opId,
        ok: true,
        data: Array.isArray(result?.data) ? result.data : [],
        partialFailures: partialFailures && partialFailures.length ? partialFailures : undefined,
        transactionApplied: result?.transactionApplied
    }
}

function withTrace(error: any, meta: { traceId?: string; requestId?: string; opId?: string }) {
    if (!error || typeof error !== 'object') return error
    const details = (error as any).details
    const nextDetails = (details && typeof details === 'object' && !Array.isArray(details))
        ? { ...details, ...meta }
        : { kind: 'internal', ...meta }
    return { ...error, details: nextDetails }
}

async function runItem<T>(
    adapter: { orm: IOrmAdapter; sync?: ISyncAdapter },
    options: { syncEnabled: boolean; idempotencyTtlMs?: number },
    fn: (args: { orm: IOrmAdapter; tx?: unknown }) => Promise<T>
): Promise<T> {
    if (options.syncEnabled) {
        return adapter.orm.transaction(async (tx) => fn({ orm: tx.orm, tx: tx.tx }))
    }
    return fn({ orm: adapter.orm, tx: undefined })
}

async function executeBulkCreate(
    op: Extract<BatchOp, { action: 'bulkCreate' }>,
    adapter: { orm: IOrmAdapter; sync?: ISyncAdapter },
    meta: { traceId?: string; requestId?: string },
    options: { syncEnabled: boolean; idempotencyTtlMs?: number }
): Promise<BatchResult> {
    const payload = Array.isArray(op.payload) ? op.payload : []
    const data: any[] = []
    const partialFailures: Array<{ index: number; error: any }> = []

    for (let i = 0; i < payload.length; i++) {
        const raw = payload[i]
        const wrapped = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as any)
            : undefined
        const itemData = (wrapped && wrapped.__atoma && typeof wrapped.__atoma === 'object' && (wrapped as any).data !== undefined)
            ? (wrapped as any).data
            : raw
        const itemKey = (wrapped && wrapped.__atoma && typeof wrapped.__atoma === 'object')
            ? (wrapped.__atoma as any).idempotencyKey
            : undefined

        const res = await runItem(adapter, options, async ({ orm, tx }) => {
            return executeWriteItemWithSemantics({
                orm,
                sync: adapter.sync,
                tx,
                syncEnabled: options.syncEnabled,
                idempotencyTtlMs: options.idempotencyTtlMs,
                meta: { ...meta, opId: op.opId },
                write: {
                    kind: 'create',
                    resource: op.resource,
                    idempotencyKey: typeof itemKey === 'string' ? itemKey : (payload.length === 1 ? op.options?.idempotencyKey : undefined),
                    data: itemData
                }
            })
        })

        if (res.ok) {
            data.push(res.data)
            continue
        }
        partialFailures.push({ index: i, error: withTrace(res.error, { ...meta, opId: op.opId }) })
    }

    return {
        opId: op.opId,
        ok: true,
        data,
        partialFailures: partialFailures.length ? partialFailures : undefined,
        transactionApplied: options.syncEnabled
    }
}

async function executeBulkPatch(
    op: Extract<BatchOp, { action: 'bulkPatch' }>,
    adapter: { orm: IOrmAdapter; sync?: ISyncAdapter },
    meta: { traceId?: string; requestId?: string },
    options: { syncEnabled: boolean; idempotencyTtlMs?: number }
): Promise<BatchResult> {
    const payload = Array.isArray(op.payload) ? op.payload : []
    const data: any[] = []
    const partialFailures: Array<{ index: number; error: any }> = []

    for (let i = 0; i < payload.length; i++) {
        const item = payload[i] as any
        const itemKey = item && typeof item === 'object' && !Array.isArray(item) ? item.idempotencyKey : undefined

        const res = await runItem(adapter, options, async ({ orm, tx }) => {
            return executeWriteItemWithSemantics({
                orm,
                sync: adapter.sync,
                tx,
                syncEnabled: options.syncEnabled,
                idempotencyTtlMs: options.idempotencyTtlMs,
                meta: { ...meta, opId: op.opId },
                write: {
                    kind: 'patch',
                    resource: op.resource,
                    idempotencyKey: typeof itemKey === 'string' ? itemKey : (payload.length === 1 ? op.options?.idempotencyKey : undefined),
                    id: item?.id,
                    patches: item?.patches,
                    baseVersion: item?.baseVersion,
                    timestamp: item?.timestamp
                }
            })
        })

        if (res.ok) {
            data.push(res.data)
            continue
        }
        partialFailures.push({ index: i, error: withTrace(res.error, { ...meta, opId: op.opId }) })
    }

    return {
        opId: op.opId,
        ok: true,
        data,
        partialFailures: partialFailures.length ? partialFailures : undefined,
        transactionApplied: options.syncEnabled
    }
}

async function executeBulkUpdateAsPatch(
    op: Extract<BatchOp, { action: 'bulkUpdate' }>,
    adapter: { orm: IOrmAdapter; sync?: ISyncAdapter },
    meta: { traceId?: string; requestId?: string },
    options: { syncEnabled: boolean; idempotencyTtlMs?: number }
): Promise<BatchResult> {
    const payload = Array.isArray(op.payload) ? op.payload : []
    const data: any[] = []
    const partialFailures: Array<{ index: number; error: any }> = []

    for (let i = 0; i < payload.length; i++) {
        const item = payload[i] as any
        const itemKey = item && typeof item === 'object' && !Array.isArray(item) ? item.idempotencyKey : undefined
        const baseVersion = (typeof item?.baseVersion === 'number' ? item.baseVersion : item?.clientVersion)
        const full = (item?.data && typeof item.data === 'object') ? { ...item.data, id: item.id } : { id: item.id }
        const patches = [{ op: 'replace', path: [item.id], value: full }]

        const res = await runItem(adapter, options, async ({ orm, tx }) => {
            return executeWriteItemWithSemantics({
                orm,
                sync: adapter.sync,
                tx,
                syncEnabled: options.syncEnabled,
                idempotencyTtlMs: options.idempotencyTtlMs,
                meta: { ...meta, opId: op.opId },
                write: {
                    kind: 'patch',
                    resource: op.resource,
                    idempotencyKey: typeof itemKey === 'string' ? itemKey : (payload.length === 1 ? op.options?.idempotencyKey : undefined),
                    id: item?.id,
                    patches,
                    baseVersion
                }
            })
        })

        if (res.ok) {
            data.push(res.data)
            continue
        }
        partialFailures.push({ index: i, error: withTrace(res.error, { ...meta, opId: op.opId }) })
    }

    return {
        opId: op.opId,
        ok: true,
        data,
        partialFailures: partialFailures.length ? partialFailures : undefined,
        transactionApplied: options.syncEnabled
    }
}

async function executeBulkDelete(
    op: Extract<BatchOp, { action: 'bulkDelete' }>,
    adapter: { orm: IOrmAdapter; sync?: ISyncAdapter },
    meta: { traceId?: string; requestId?: string },
    options: { syncEnabled: boolean; idempotencyTtlMs?: number }
): Promise<BatchResult> {
    const payload = Array.isArray(op.payload) ? op.payload : []
    const data: any[] = []
    const partialFailures: Array<{ index: number; error: any }> = []

    for (let i = 0; i < payload.length; i++) {
        const raw = payload[i] as any
        const id = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.id : raw
        const baseVersion = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.baseVersion : undefined
        const itemKey = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.idempotencyKey : undefined

        const res = await runItem(adapter, options, async ({ orm, tx }) => {
            return executeWriteItemWithSemantics({
                orm,
                sync: adapter.sync,
                tx,
                syncEnabled: options.syncEnabled,
                idempotencyTtlMs: options.idempotencyTtlMs,
                meta: { ...meta, opId: op.opId },
                write: {
                    kind: 'delete',
                    resource: op.resource,
                    idempotencyKey: typeof itemKey === 'string' ? itemKey : (payload.length === 1 ? op.options?.idempotencyKey : undefined),
                    id,
                    baseVersion
                }
            })
        })

        if (res.ok) {
            data.push(undefined)
            continue
        }
        partialFailures.push({ index: i, error: withTrace(res.error, { ...meta, opId: op.opId }) })
    }

    return {
        opId: op.opId,
        ok: true,
        data,
        partialFailures: partialFailures.length ? partialFailures : undefined,
        transactionApplied: options.syncEnabled
    }
}
