import pLimit from 'p-limit'
import { createError, errorStatus, toStandardError } from '../../error'
import type { AtomaOpPluginContext, AtomaOpPluginResult, AtomaServerPluginRuntime, AtomaServerRoute } from '../../config'
import { Protocol } from 'atoma-protocol'
import type { OperationResult, WriteOp } from 'atoma-protocol'
import type { IOrmAdapter, ISyncAdapter } from '../../adapters/ports'
import { executeWriteItemWithSemantics } from '../writeSemantics'
import { isObject } from './normalize'

type TraceMeta = { traceId?: string; requestId?: string; opId: string }

function serializeErrorForLog(error: unknown) {
    if (error instanceof Error) {
        const anyErr = error as any
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            ...(anyErr?.cause !== undefined ? { cause: anyErr.cause } : {})
        }
    }
    return { value: error }
}

function normalizeId(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (value === null || value === undefined) return ''
    return String(value)
}

function hasOwn(obj: any, key: string): boolean {
    return Boolean(obj) && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)
}

function isPlainObject(value: any): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function ensureSelect(select: Record<string, boolean> | undefined, required: string[]): Record<string, boolean> | undefined {
    if (!select) return undefined
    const out: Record<string, boolean> = { ...select }
    required.forEach(key => { out[key] = true })
    return out
}

function requiredSelectFields(action: string): string[] {
    if (action === 'create') return ['id', 'version']
    if (action === 'update') return ['version']
    if (action === 'upsert') return ['version']
    return []
}

function validateCreateEntityIdMatchesValue(raw: any): { ok: true } | { ok: false; reason: string } {
    const entityId = raw?.entityId
    const value = raw?.value
    if (entityId === undefined || entityId === null) return { ok: true }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: true }
    if (!hasOwn(value, 'id')) return { ok: true }

    const valueId = (value as any).id
    if (valueId === undefined || valueId === null) return { ok: true }

    const a = normalizeId(entityId)
    const b = normalizeId(valueId)
    if (!a || !b) return { ok: true }
    if (a !== b) return { ok: false, reason: 'Create entityId does not match value.id' }
    return { ok: true }
}

function extractConflictMeta(error: any) {
    const details = (error as any)?.details
    const currentValue = details && typeof details === 'object' ? (details as any).currentValue : undefined
    const currentVersion = details && typeof details === 'object' ? (details as any).currentVersion : undefined
    return {
        ...(currentValue !== undefined ? { currentValue } : {}),
        ...(typeof currentVersion === 'number' ? { currentVersion } : {})
    }
}

function extractWriteItemMeta(raw: any): { idempotencyKey?: string; timestamp?: number } {
    const meta = isObject(raw?.meta) ? raw.meta : undefined
    const idempotencyKey = meta && typeof meta.idempotencyKey === 'string' ? meta.idempotencyKey : undefined
    const timestamp = meta && typeof meta.clientTimeMs === 'number' ? meta.clientTimeMs : undefined
    return { idempotencyKey, timestamp }
}

function toOkItemResult(index: number, res: any) {
    return {
        index,
        ok: true,
        entityId: res.replay.id,
        version: res.replay.serverVersion,
        ...(res.data !== undefined ? { data: res.data } : {})
    }
}

function toFailItemResult(index: number, res: any, trace: TraceMeta) {
    const currentValue = res.replay.currentValue
    const currentVersion = res.replay.currentVersion
    return {
        index,
        ok: false,
        error: Protocol.error.withTrace(res.error, trace),
        ...(currentValue !== undefined || currentVersion !== undefined
            ? { current: { ...(currentValue !== undefined ? { value: currentValue } : {}), ...(currentVersion !== undefined ? { version: currentVersion } : {}) } }
            : {})
    }
}

function toUnhandledItemError(index: number, err: unknown, trace: TraceMeta) {
    return {
        index,
        ok: false,
        error: Protocol.error.withTrace(toStandardError(err, 'WRITE_FAILED'), trace)
    }
}

export async function executeWriteOps<Ctx>(args: {
    adapter: IOrmAdapter
    syncAdapter?: ISyncAdapter
    syncEnabled: boolean
    idempotencyTtlMs: number
    writeOps: WriteOp[]
    route: AtomaServerRoute
    pluginRuntime: AtomaServerPluginRuntime<Ctx>
    runOpPlugins: (ctx: AtomaOpPluginContext<Ctx>, next: () => Promise<AtomaOpPluginResult>) => Promise<AtomaOpPluginResult>
    traceMetaForOpId: (opId: string) => TraceMeta
    resultsByOpId: Map<string, OperationResult>
}) {
    if (!args.writeOps.length) return

    const limit = pLimit(8)

    await Promise.all(args.writeOps.map(op => limit(async () => {
        const opTrace = args.traceMetaForOpId(op.opId)
        const resource = op.write.resource
        const action = op.write.action
        const items = Array.isArray(op.write.items) ? op.write.items : []

        const pluginResult = await args.runOpPlugins({
            opId: op.opId,
            kind: 'write',
            resource,
            op,
            route: args.route,
            runtime: args.pluginRuntime
        }, async () => {
            const sync = args.syncEnabled ? args.syncAdapter : undefined
            if (args.syncEnabled && !sync) {
                throw new Error('executeWriteOps requires sync adapter when syncEnabled=true')
            }

            const readIdempotency = async (key: string, tx?: unknown): Promise<any | undefined> => {
                if (!args.syncEnabled) return undefined
                const hit = await sync!.getIdempotency(key, tx)
                if (!hit.hit) return undefined
                const body = hit.body
                if (!body || typeof body !== 'object') return undefined
                if ((body as any).kind !== 'write') return undefined
                const value = (body as any).value
                if (!value || typeof value !== 'object') return undefined
                const kind = (value as any).kind
                if (kind !== 'ok' && kind !== 'error') return undefined
                return value
            }

            const writeIdempotency = async (key: string, replay: any, status: number, tx?: unknown) => {
                if (!args.syncEnabled) return
                await sync!.putIdempotency(
                    key,
                    { status, body: { kind: 'write', value: replay } },
                    args.idempotencyTtlMs,
                    tx
                )
            }

            const invalidWrite = (message: string) => toStandardError(createError('INVALID_WRITE', message, { kind: 'validation', resource }))

            const executeSingleInContext = async (ctx: { orm: IOrmAdapter; tx?: unknown }, index: number) => {
                const raw = items[index] as any
                const { idempotencyKey, timestamp } = extractWriteItemMeta(raw)

                try {
                    const base = {
                        resource,
                        ...(idempotencyKey ? { idempotencyKey } : {})
                    }

                    if (action === 'create') {
                        const match = validateCreateEntityIdMatchesValue(raw)
                        if (!match.ok) {
                            const standard = invalidWrite(match.reason)
                            const replay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }
                            if (args.syncEnabled && idempotencyKey) await writeIdempotency(idempotencyKey, replay, errorStatus(standard), ctx.tx)
                            const res: any = { ok: false, status: errorStatus(standard), error: standard, replay }
                            args.pluginRuntime.logger?.warn?.('write item rejected', {
                                opId: opTrace.opId,
                                ...(opTrace.traceId ? { traceId: opTrace.traceId } : {}),
                                ...(opTrace.requestId ? { requestId: opTrace.requestId } : {}),
                                resource,
                                action,
                                index,
                                entityId: raw?.entityId,
                                baseVersion: raw?.baseVersion,
                                idempotencyKey,
                                error: standard
                            })
                            return toFailItemResult(index, res, opTrace)
                        }
                    }

                    const res = await executeWriteItemWithSemantics({
                        orm: ctx.orm,
                        sync,
                        tx: ctx.tx,
                        syncEnabled: args.syncEnabled,
                        idempotencyTtlMs: args.idempotencyTtlMs,
                        meta: opTrace,
                        logger: args.pluginRuntime.logger,
                        write: (() => {
                            if (action === 'create') {
                                return {
                                    kind: 'create',
                                    ...base,
                                    id: raw?.entityId,
                                    data: raw?.value,
                                    ...(op.write.options !== undefined ? { options: op.write.options as any } : {})
                                }
                            }
                            if (action === 'update') {
                                return {
                                    kind: 'update',
                                    ...base,
                                    id: raw?.entityId,
                                    baseVersion: raw?.baseVersion,
                                    data: raw?.value,
                                    ...(op.write.options !== undefined ? { options: op.write.options as any } : {})
                                }
                            }
                            if (action === 'upsert') {
                                return {
                                    kind: 'upsert',
                                    ...base,
                                    id: raw?.entityId,
                                    baseVersion: raw?.baseVersion,
                                    data: raw?.value,
                                    ...(timestamp !== undefined ? { timestamp } : {}),
                                    ...(op.write.options !== undefined ? { options: op.write.options as any } : {})
                                }
                            }
                            return {
                                kind: 'delete',
                                ...base,
                                id: raw?.entityId,
                                baseVersion: raw?.baseVersion,
                                ...(op.write.options !== undefined ? { options: op.write.options as any } : {})
                            }
                        })()
                    })

                    if (res.ok) return toOkItemResult(index, res)
                    return toFailItemResult(index, res, opTrace)
                } catch (err) {
                    args.pluginRuntime.logger?.error?.('write item threw', {
                        opId: opTrace.opId,
                        ...(opTrace.traceId ? { traceId: opTrace.traceId } : {}),
                        ...(opTrace.requestId ? { requestId: opTrace.requestId } : {}),
                        resource,
                        action,
                        index,
                        entityId: raw?.entityId,
                        baseVersion: raw?.baseVersion,
                        idempotencyKey,
                        error: serializeErrorForLog(err)
                    })
                    return toUnhandledItemError(index, err, opTrace)
                }
            }

            const executePerItemInContext = async (ctx: { orm: IOrmAdapter; tx?: unknown }) => {
                const itemResults: any[] = new Array(items.length)

                for (let i = 0; i < items.length; i++) {
                    itemResults[i] = await executeSingleInContext(ctx, i)
                }

                return itemResults
            }

            const executeBulkInContext = async (ctx: { orm: IOrmAdapter; tx?: unknown }) => {
                const itemResults: any[] = new Array(items.length)

                const bulkFn = (() => {
                    if (action === 'create') return (ctx.orm as any).bulkCreate
                    if (action === 'update') return (ctx.orm as any).bulkUpdate
                    if (action === 'upsert') return (ctx.orm as any).bulkUpsert
                    return (ctx.orm as any).bulkDelete
                })()

                if (typeof bulkFn !== 'function') {
                    return executePerItemInContext(ctx)
                }

                const options = (op.write.options && isPlainObject(op.write.options))
                    ? (op.write.options as any)
                    : {}
                const upsertMode: 'strict' | 'loose' = (options as any)?.upsert?.mode === 'loose' ? 'loose' : 'strict'
                const upsertMerge: boolean = options.merge !== false
                const returningRequested = action === 'upsert' ? options.returning !== false : true
                const requestedSelect = isPlainObject(options.select) ? (options.select as Record<string, boolean>) : undefined
                const internalSelect = ensureSelect(requestedSelect, requiredSelectFields(action))

                const pending: Array<{ index: number; raw: any; idempotencyKey?: string; timestamp?: number }> = []

                for (let i = 0; i < items.length; i++) {
                    const raw = items[i] as any
                    const { idempotencyKey, timestamp } = extractWriteItemMeta(raw)

                    if (args.syncEnabled && idempotencyKey) {
                        const replayHit = await readIdempotency(idempotencyKey, ctx.tx)
                        if (replayHit) {
                            if (replayHit.kind === 'ok') {
                                const res: any = { ok: true, status: 200, data: replayHit.data, replay: replayHit }
                                itemResults[i] = toOkItemResult(i, res)
                            } else {
                                const res: any = { ok: false, status: errorStatus(replayHit.error), error: replayHit.error, replay: replayHit }
                                itemResults[i] = toFailItemResult(i, res, opTrace)
                            }
                            continue
                        }
                    }

                    if (action === 'update') {
                        const baseVersion = raw?.baseVersion
                        if (raw?.entityId === undefined) {
                            const standard = invalidWrite('Missing id for update')
                            const replay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }
                            if (args.syncEnabled && idempotencyKey) await writeIdempotency(idempotencyKey, replay, errorStatus(standard), ctx.tx)
                            const res: any = { ok: false, status: errorStatus(standard), error: standard, replay }
                            itemResults[i] = toFailItemResult(i, res, opTrace)
                            continue
                        }
                        if (typeof baseVersion !== 'number' || !Number.isFinite(baseVersion) || baseVersion <= 0) {
                            const standard = invalidWrite('Missing baseVersion for update')
                            const replay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }
                            if (args.syncEnabled && idempotencyKey) await writeIdempotency(idempotencyKey, replay, errorStatus(standard), ctx.tx)
                            const res: any = { ok: false, status: errorStatus(standard), error: standard, replay }
                            itemResults[i] = toFailItemResult(i, res, opTrace)
                            continue
                        }
                    }

                    if (action === 'upsert') {
                        if (raw?.entityId === undefined) {
                            const standard = invalidWrite('Missing id for upsert')
                            const replay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }
                            if (args.syncEnabled && idempotencyKey) await writeIdempotency(idempotencyKey, replay, errorStatus(standard), ctx.tx)
                            const res: any = { ok: false, status: errorStatus(standard), error: standard, replay }
                            itemResults[i] = toFailItemResult(i, res, opTrace)
                            continue
                        }
                    }

                    if (action === 'create') {
                        const match = validateCreateEntityIdMatchesValue(raw)
                        if (!match.ok) {
                            const standard = invalidWrite(match.reason)
                            const replay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }
                            if (args.syncEnabled && idempotencyKey) await writeIdempotency(idempotencyKey, replay, errorStatus(standard), ctx.tx)
                            const res: any = { ok: false, status: errorStatus(standard), error: standard, replay }
                            itemResults[i] = toFailItemResult(i, res, opTrace)
                            continue
                        }
                    }

                    if (action === 'delete') {
                        const baseVersion = raw?.baseVersion
                        if (raw?.entityId === undefined) {
                            const standard = invalidWrite('Missing id for delete')
                            const replay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }
                            if (args.syncEnabled && idempotencyKey) await writeIdempotency(idempotencyKey, replay, errorStatus(standard), ctx.tx)
                            const res: any = { ok: false, status: errorStatus(standard), error: standard, replay }
                            itemResults[i] = toFailItemResult(i, res, opTrace)
                            continue
                        }
                        if (typeof baseVersion !== 'number' || !Number.isFinite(baseVersion)) {
                            const standard = invalidWrite('Missing baseVersion for delete')
                            const replay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }
                            if (args.syncEnabled && idempotencyKey) await writeIdempotency(idempotencyKey, replay, errorStatus(standard), ctx.tx)
                            const res: any = { ok: false, status: errorStatus(standard), error: standard, replay }
                            itemResults[i] = toFailItemResult(i, res, opTrace)
                            continue
                        }
                    }

                    pending.push({ index: i, raw, idempotencyKey, timestamp })
                }

                if (!pending.length) return itemResults

                if (pending.length <= 1) {
                    const only = pending[0]
                    itemResults[only.index] = await executeSingleInContext(ctx, only.index)
                    return itemResults
                }

                const bulkItems = (() => {
                    if (action === 'create') {
                        return pending.map(p => {
                            const value = p.raw?.value
                            const data = (value && typeof value === 'object' && !Array.isArray(value))
                                ? { ...(value as any) }
                                : {}
                            if (p.raw?.entityId !== undefined && p.raw?.entityId !== null) {
                                ;(data as any).id = p.raw?.entityId
                            }
                            const v = (data as any).version
                            if (!(typeof v === 'number' && Number.isFinite(v) && v >= 1)) (data as any).version = 1
                            return data
                        })
                    }
                    if (action === 'update') {
                        return pending.map(p => {
                            const value = p.raw?.value
                            const data = (value && typeof value === 'object' && !Array.isArray(value))
                                ? { ...(value as any) }
                                : {}
                            return { id: p.raw?.entityId, data, baseVersion: p.raw?.baseVersion }
                        })
                    }
                    if (action === 'upsert') {
                        return pending.map(p => {
                            const value = p.raw?.value
                            const data = (value && typeof value === 'object' && !Array.isArray(value))
                                ? { ...(value as any) }
                                : {}
                            return {
                                id: p.raw?.entityId,
                                data,
                                baseVersion: p.raw?.baseVersion,
                                ...(p.timestamp !== undefined ? { timestamp: p.timestamp } : {}),
                                mode: upsertMode,
                                merge: upsertMerge
                            }
                        })
                    }
                    return pending.map(p => ({ id: p.raw?.entityId, baseVersion: p.raw?.baseVersion }))
                })()

                const bulkOptions = (() => {
                    if (action === 'delete') return { returning: false }
                    if (action === 'upsert') return { ...options, returning: true, ...(internalSelect ? { select: internalSelect } : {}) }
                    return { returning: true, ...(internalSelect ? { select: internalSelect } : {}) }
                })()

                const bulkRes = await bulkFn.call(ctx.orm, resource, bulkItems, bulkOptions)
                const resultsByIndex = Array.isArray((bulkRes as any)?.resultsByIndex) ? (bulkRes as any).resultsByIndex : []

                for (let j = 0; j < pending.length; j++) {
                    const p = pending[j]
                    const r = resultsByIndex[j]

                    try {
                        if (!r) {
                            throw createError('INTERNAL', 'Missing bulk result', { kind: 'adapter' })
                        }

                        if (r.ok) {
                            const row = r.data
                            const expected = normalizeId(p.raw?.entityId)
                            const actual = normalizeId((row as any)?.id)

                            const id = action === 'create'
                                ? (expected ? expected : actual)
                                : normalizeId(p.raw?.entityId)

                            if (action === 'create' && !id) {
                                throw createError('INTERNAL', 'Create returned missing id', { kind: 'internal', resource })
                            }

                            if (action === 'create' && expected && actual && actual !== expected) {
                                throw createError('INTERNAL', `Create returned mismatched id (expected=${expected}, actual=${actual})`, { kind: 'internal', resource })
                            }

                            const baseVersion = p.raw?.baseVersion
                            const rowVersion = typeof (row as any)?.version === 'number' ? (row as any).version : undefined
                            const serverVersion = (() => {
                                if (action === 'delete') {
                                    return (typeof baseVersion === 'number' && Number.isFinite(baseVersion)) ? baseVersion + 1 : 1
                                }
                                if (typeof rowVersion === 'number' && Number.isFinite(rowVersion) && rowVersion >= 1) return rowVersion
                                if (typeof baseVersion === 'number' && Number.isFinite(baseVersion)) return baseVersion + 1
                                if (action === 'upsert' && upsertMode === 'loose') {
                                    throw createError('INTERNAL', 'Upsert returned missing version', { kind: 'internal', resource })
                                }
                                return 1
                            })()

                            let change: any | undefined
                            if (args.syncEnabled) {
                                change = await sync!.appendChange({
                                    resource,
                                    id,
                                    kind: action === 'delete' ? 'delete' : 'upsert',
                                    serverVersion,
                                    changedAt: Date.now()
                                }, ctx.tx)
                            }

                            const replay: any = {
                                kind: 'ok',
                                resource,
                                id,
                                changeKind: action === 'delete' ? 'delete' : 'upsert',
                                serverVersion,
                                ...(change ? { cursor: change.cursor } : {}),
                                ...((action !== 'delete' && returningRequested)
                                    ? {
                                        data: (action === 'create' && row && typeof row === 'object' && !Array.isArray(row))
                                            ? { ...(row as any), id }
                                            : row
                                    }
                                    : {})
                            }

                            const res: any = {
                                ok: true,
                                status: 200,
                                replay,
                                ...((action !== 'delete' && returningRequested)
                                    ? {
                                        data: (action === 'create' && row && typeof row === 'object' && !Array.isArray(row))
                                            ? { ...(row as any), id }
                                            : row
                                    }
                                    : {})
                            }

                            if (args.syncEnabled && p.idempotencyKey) {
                                await writeIdempotency(p.idempotencyKey, replay, 200, ctx.tx)
                            }

                            itemResults[p.index] = toOkItemResult(p.index, res)
                            continue
                        }

                        const standard = toStandardError(r.error, 'WRITE_FAILED')
                        const status = errorStatus(standard)
                        const replay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }

                        if (args.syncEnabled && p.idempotencyKey) {
                            await writeIdempotency(p.idempotencyKey, replay, status, ctx.tx)
                        }

                        const logMeta = {
                            opId: opTrace.opId,
                            ...(opTrace.traceId ? { traceId: opTrace.traceId } : {}),
                            ...(opTrace.requestId ? { requestId: opTrace.requestId } : {}),
                            resource,
                            action,
                            index: p.index,
                            entityId: p.raw?.entityId,
                            baseVersion: p.raw?.baseVersion,
                            idempotencyKey: p.idempotencyKey,
                            rawError: serializeErrorForLog(r.error),
                            error: standard
                        }
                        if (standard.kind === 'validation' || standard.code === 'CONFLICT') {
                            args.pluginRuntime.logger?.warn?.('write item failed', logMeta)
                        } else {
                            args.pluginRuntime.logger?.error?.('write item failed', logMeta)
                        }
                        const res: any = { ok: false, status, error: standard, replay }
                        itemResults[p.index] = toFailItemResult(p.index, res, opTrace)
                    } catch (err) {
                        args.pluginRuntime.logger?.error?.('write item threw', {
                            opId: opTrace.opId,
                            ...(opTrace.traceId ? { traceId: opTrace.traceId } : {}),
                            ...(opTrace.requestId ? { requestId: opTrace.requestId } : {}),
                            resource,
                            action,
                            index: p.index,
                            entityId: p.raw?.entityId,
                            baseVersion: p.raw?.baseVersion,
                            idempotencyKey: p.idempotencyKey,
                            error: serializeErrorForLog(err)
                        })
                        itemResults[p.index] = toUnhandledItemError(p.index, err, opTrace)
                    }
                }

                return itemResults
            }

            const itemResults = await (async () => {
                if (!args.syncEnabled) {
                    return executeBulkInContext({ orm: args.adapter, tx: undefined })
                }

                try {
                    return await args.adapter.transaction(async (tx) => executeBulkInContext({ orm: tx.orm, tx: tx.tx }))
                } catch {
                    const fallback: any[] = new Array(items.length)
                    for (let i = 0; i < items.length; i++) {
                        try {
                            fallback[i] = await args.adapter.transaction(async (tx) => executeSingleInContext({ orm: tx.orm, tx: tx.tx }, i))
                        } catch (err) {
                            fallback[i] = toUnhandledItemError(i, err, opTrace)
                        }
                    }
                    return fallback
                }
            })()

            const transactionApplied = args.syncEnabled
            return { ok: true, data: { transactionApplied, results: itemResults } }
        })

        if (pluginResult.ok) {
            args.resultsByOpId.set(op.opId, { opId: op.opId, ok: true, data: pluginResult.data })
            return
        }

        args.pluginRuntime.logger?.error?.('write op failed', {
            opId: opTrace.opId,
            ...(opTrace.traceId ? { traceId: opTrace.traceId } : {}),
            ...(opTrace.requestId ? { requestId: opTrace.requestId } : {}),
            resource: op.write?.resource,
            action: op.write?.action,
            error: serializeErrorForLog(pluginResult.error)
        })
        const standard = Protocol.error.withTrace(
            toStandardError(pluginResult.error, 'WRITE_FAILED'),
            opTrace
        )
        args.resultsByOpId.set(op.opId, { opId: op.opId, ok: false, error: standard })
    })))
}
