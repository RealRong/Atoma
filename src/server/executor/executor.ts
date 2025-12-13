import pLimit from 'p-limit'
import type { BatchOp, BatchRequest, BatchResponse, BatchResult, IOrmAdapter } from '../types'
import { toStandardError } from '../error'

export async function executeRequest(request: BatchRequest, adapter: IOrmAdapter): Promise<BatchResponse> {
    const ops = Array.isArray(request.ops) ? request.ops : []
    const results: BatchResult[] = new Array(ops.length)
    const traceMeta = { traceId: request.traceId, requestId: request.requestId }

    const queryEntries: Array<{ index: number; op: Extract<BatchOp, { action: 'query' }> }> = []
    const writeEntries: Array<{ index: number; op: Exclude<BatchOp, { action: 'query' }> }> = []

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i]
        if (op.action === 'query') queryEntries.push({ index: i, op })
        else writeEntries.push({ index: i, op })
    }

    await Promise.all([
        executeQueries(queryEntries, adapter, results, traceMeta),
        executeWrites(writeEntries, adapter, results, traceMeta)
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
    adapter: IOrmAdapter,
    out: BatchResult[],
    meta: { traceId?: string; requestId?: string }
) {
    if (!entries.length) return

    const limit = pLimit(8)

    const settled = await Promise.allSettled(entries.map(e => limit(async () => {
        const op = e.op
        try {
            switch (op.action) {
                case 'bulkCreate': {
                    if (typeof adapter.bulkCreate !== 'function') {
                        out[e.index] = adapterNotImplemented(op.opId, op.action)
                        return
                    }
                    const res = await adapter.bulkCreate(op.resource, op.payload, op.options)
                    out[e.index] = wrapMany(op.opId, res, meta)
                    return
                }
                case 'bulkUpdate': {
                    if (typeof adapter.bulkUpdate !== 'function') {
                        out[e.index] = adapterNotImplemented(op.opId, op.action)
                        return
                    }
                    const res = await adapter.bulkUpdate(op.resource, op.payload as any, op.options)
                    out[e.index] = wrapMany(op.opId, res, meta)
                    return
                }
                case 'bulkPatch': {
                    if (typeof adapter.bulkPatch !== 'function') {
                        out[e.index] = adapterNotImplemented(op.opId, op.action)
                        return
                    }
                    const res = await adapter.bulkPatch(op.resource, op.payload as any, op.options)
                    out[e.index] = wrapMany(op.opId, res, meta)
                    return
                }
                case 'bulkDelete': {
                    if (typeof adapter.bulkDelete !== 'function') {
                        out[e.index] = adapterNotImplemented(op.opId, op.action)
                        return
                    }
                    const res = await adapter.bulkDelete(op.resource, op.payload, op.options)
                    out[e.index] = wrapMany(op.opId, res, meta)
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
