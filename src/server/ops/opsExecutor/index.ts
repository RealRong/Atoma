import { byteLengthUtf8, throwError, toStandardError } from '../../error'
import type { AtomaOpPlugin, AtomaOpPluginContext, AtomaOpPluginResult, AtomaServerConfig, AtomaServerRoute } from '../../config'
import type { ServerRuntime } from '../../runtime/createRuntime'
import { Protocol } from '#protocol'
import type {
    ChangesPullOp,
    OperationResult,
    QueryOp,
    WriteOp
} from '#protocol'
import type { IOrmAdapter } from '../../adapters/ports'
import { clampQueryLimit, ensureV1, normalizeOpsRequest, normalizeOperation, parseCursorV1 } from './normalize'
import { executeQueryOps } from './query'
import { executeWriteOps } from './write'

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

            await executeQueryOps({
                adapter,
                queryOps,
                hasOpPlugins: Boolean(opPlugins.length),
                route,
                pluginRuntime,
                runOpPlugins,
                traceMetaForOpId,
                resultsByOpId
            })

            await executeWriteOps({
                adapter,
                syncAdapter: args.config.adapter.sync,
                syncEnabled,
                idempotencyTtlMs,
                writeOps,
                route,
                pluginRuntime,
                runOpPlugins,
                traceMetaForOpId,
                resultsByOpId
            })

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
