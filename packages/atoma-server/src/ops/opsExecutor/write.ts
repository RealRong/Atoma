import pLimit from 'p-limit'
import { createError, errorStatus, toStandardError } from '../../error'
import type { AtomaOpPluginContext, AtomaOpPluginResult, AtomaServerPluginRuntime, AtomaServerRoute } from '../../config'
import { withErrorTrace } from 'atoma-types/protocol-tools'
import type { RemoteOpResult, WriteOp } from 'atoma-types/protocol'
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

function validateCreateIdMatchesValue(raw: any): { ok: true } | { ok: false; reason: string } {
    const id = raw?.id
    const value = raw?.value
    if (id === undefined || id === null) return { ok: true }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: true }
    if (!hasOwn(value, 'id')) return { ok: true }

    const valueId = (value as any).id
    if (valueId === undefined || valueId === null) return { ok: true }

    const a = normalizeId(id)
    const b = normalizeId(valueId)
    if (!a || !b) return { ok: true }
    if (a !== b) return { ok: false, reason: 'Create id does not match value.id' }
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

function toOkItemResult(res: any) {
    return {
        ok: true,
        id: res.replay.id,
        version: res.replay.serverVersion,
        ...(res.data !== undefined ? { data: res.data } : {})
    }
}

function toFailItemResult(res: any, trace: TraceMeta) {
    const currentValue = res.replay.currentValue
    const currentVersion = res.replay.currentVersion
    return {
        ok: false,
        error: withErrorTrace(res.error, trace),
        ...(currentValue !== undefined || currentVersion !== undefined
            ? { current: { ...(currentValue !== undefined ? { value: currentValue } : {}), ...(currentVersion !== undefined ? { version: currentVersion } : {}) } }
            : {})
    }
}

function toUnhandledItemError(err: unknown, trace: TraceMeta) {
    return {
        ok: false,
        error: withErrorTrace(toStandardError(err, 'WRITE_FAILED'), trace)
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
    resultsByOpId: Map<string, RemoteOpResult>
}) {
    if (!args.writeOps.length) return

    const limit = pLimit(8)

    await Promise.all(args.writeOps.map(op => limit(async () => {
        const opTrace = args.traceMetaForOpId(op.opId)
        const resource = op.write.resource
        const entries = Array.isArray(op.write.entries) ? op.write.entries : []
        const action = entries.length ? entries[0]?.action : undefined
        if (action !== 'create' && action !== 'update' && action !== 'upsert' && action !== 'delete') {
            throw new Error('Invalid write action')
        }
        if (entries.some(entry => entry.action !== action)) {
            throw new Error('Mixed write actions in one op are not supported')
        }
        const items = entries.map(entry => entry.item)
        const firstOptions = entries.length ? ((entries[0] as any)?.options) : undefined
        if (entries.some(entry => JSON.stringify((entry as any)?.options ?? null) !== JSON.stringify(firstOptions ?? null))) {
            throw new Error('Mixed write options in one op are not supported')
        }
        const writeOptions = firstOptions

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
                        const match = validateCreateIdMatchesValue(raw)
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
                                id: raw?.id,
                                baseVersion: raw?.baseVersion,
                                idempotencyKey,
                                error: standard
                            })
                            return toFailItemResult(res, opTrace)
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
                                    id: raw?.id,
                                    data: raw?.value,
                                    ...(writeOptions !== undefined ? { options: writeOptions as any } : {})
                                }
                            }
                            if (action === 'update') {
                                return {
                                    kind: 'update',
                                    ...base,
                                    id: raw?.id,
                                    baseVersion: raw?.baseVersion,
                                    data: raw?.value,
                                    ...(writeOptions !== undefined ? { options: writeOptions as any } : {})
                                }
                            }
                            if (action === 'upsert') {
                                return {
                                    kind: 'upsert',
                                    ...base,
                                    id: raw?.id,
                                    expectedVersion: raw?.expectedVersion,
                                    data: raw?.value,
                                    ...(timestamp !== undefined ? { timestamp } : {}),
                                    ...(writeOptions !== undefined ? { options: writeOptions as any } : {})
                                }
                            }
                            return {
                                kind: 'delete',
                                ...base,
                                id: raw?.id,
                                baseVersion: raw?.baseVersion,
                                ...(writeOptions !== undefined ? { options: writeOptions as any } : {})
                            }
                        })()
                    })

                    if (res.ok) return toOkItemResult(res)
                    return toFailItemResult(res, opTrace)
                } catch (err) {
                    args.pluginRuntime.logger?.error?.('write item threw', {
                        opId: opTrace.opId,
                        ...(opTrace.traceId ? { traceId: opTrace.traceId } : {}),
                        ...(opTrace.requestId ? { requestId: opTrace.requestId } : {}),
                        resource,
                        action,
                        index,
                        id: raw?.id,
                        baseVersion: raw?.baseVersion,
                        expectedVersion: raw?.expectedVersion,
                        idempotencyKey,
                        error: serializeErrorForLog(err)
                    })
                    return toUnhandledItemError(err, opTrace)
                }
            }

            const executePerItemInContext = async (ctx: { orm: IOrmAdapter; tx?: unknown }) => {
                const itemResults: any[] = new Array(items.length)

                for (let i = 0; i < items.length; i++) {
                    itemResults[i] = await executeSingleInContext(ctx, i)
                }

                return itemResults
            }

            const itemResults = await (async () => {
                if (!args.syncEnabled) {
                    return executePerItemInContext({ orm: args.adapter, tx: undefined })
                }

                try {
                    return await args.adapter.transaction(async (tx) => executePerItemInContext({ orm: tx.orm, tx: tx.tx }))
                } catch {
                    const fallback: any[] = new Array(items.length)
                    for (let i = 0; i < items.length; i++) {
                        try {
                            fallback[i] = await args.adapter.transaction(async (tx) => executeSingleInContext({ orm: tx.orm, tx: tx.tx }, i))
                        } catch (err) {
                            fallback[i] = toUnhandledItemError(err, opTrace)
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
            action,
            error: serializeErrorForLog(pluginResult.error)
        })
        const standard = withErrorTrace(
            toStandardError(pluginResult.error, 'WRITE_FAILED'),
            opTrace
        )
        args.resultsByOpId.set(op.opId, { opId: op.opId, ok: false, error: standard })
    })))
}
