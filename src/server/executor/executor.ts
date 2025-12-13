import pLimit from 'p-limit'
import type { BatchOp, BatchRequest, BatchResponse, BatchResult, IOrmAdapter } from '../types'
import { toStandardError } from '../error'

export async function executeRequest(request: BatchRequest, adapter: IOrmAdapter): Promise<BatchResponse> {
    const ops = Array.isArray(request.ops) ? request.ops : []
    const results: BatchResult[] = new Array(ops.length)

    const queryEntries: Array<{ index: number; op: Extract<BatchOp, { action: 'query' }> }> = []
    const writeEntries: Array<{ index: number; op: Exclude<BatchOp, { action: 'query' }> }> = []

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i]
        if (op.action === 'query') queryEntries.push({ index: i, op })
        else writeEntries.push({ index: i, op })
    }

    await Promise.all([
        executeQueries(queryEntries, adapter, results),
        executeWrites(writeEntries, adapter, results)
    ])

    return { results }
}

async function executeQueries(
    entries: Array<{ index: number; op: Extract<BatchOp, { action: 'query' }> }>,
    adapter: IOrmAdapter,
    out: BatchResult[]
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
        out[e.index] = { opId: e.op.opId, ok: false, error: toStandardError(res.reason, 'QUERY_FAILED') }
    }
}

async function executeWrites(
    entries: Array<{ index: number; op: Exclude<BatchOp, { action: 'query' }> }>,
    adapter: IOrmAdapter,
    out: BatchResult[]
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
                    out[e.index] = wrapMany(op.opId, res)
                    return
                }
                case 'bulkUpdate': {
                    if (typeof adapter.bulkUpdate !== 'function') {
                        out[e.index] = adapterNotImplemented(op.opId, op.action)
                        return
                    }
                    const res = await adapter.bulkUpdate(op.resource, op.payload as any, op.options)
                    out[e.index] = wrapMany(op.opId, res)
                    return
                }
                case 'bulkPatch': {
                    if (typeof adapter.bulkPatch !== 'function') {
                        out[e.index] = adapterNotImplemented(op.opId, op.action)
                        return
                    }
                    const res = await adapter.bulkPatch(op.resource, op.payload as any, op.options)
                    out[e.index] = wrapMany(op.opId, res)
                    return
                }
                case 'bulkDelete': {
                    if (typeof adapter.bulkDelete !== 'function') {
                        out[e.index] = adapterNotImplemented(op.opId, op.action)
                        return
                    }
                    const res = await adapter.bulkDelete(op.resource, op.payload, op.options)
                    out[e.index] = wrapMany(op.opId, res)
                    return
                }
            }
        } catch (err) {
            out[e.index] = { opId: op.opId, ok: false, error: toStandardError(err, 'WRITE_FAILED') }
        }
    })))

    // Should never happen (we write into out in the limited function), but keep it safe.
    settled.forEach((r, i) => {
        if (r.status === 'rejected') {
            const e = entries[i]
            out[e.index] = { opId: e.op.opId, ok: false, error: toStandardError(r.reason, 'WRITE_FAILED') }
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

function wrapMany(opId: string, result: any): BatchResult {
    const partialFailures = Array.isArray(result?.partialFailures)
        ? result.partialFailures.map((pf: any) => ({
            index: pf.index,
            error: toStandardError(pf.error, pf.error?.code)
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
