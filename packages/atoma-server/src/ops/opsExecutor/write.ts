import pLimit from 'p-limit'
import { toStandardError } from '../../error'
import type { AtomaOpPluginContext, AtomaOpPluginResult, AtomaServerPluginRuntime, AtomaServerRoute } from '../../config'
import { withErrorTrace } from 'atoma-types/protocol-tools'
import type { RemoteOpResult, WriteOp } from 'atoma-types/protocol'
import type { IOrmAdapter, ISyncAdapter } from '../../adapters/ports'
import { executeWriteItems } from './writeItemExecutor'
import {
    serializeErrorForLog,
    type TraceMeta,
} from './writeResult'

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
            const execution = await executeWriteItems({
                adapter: args.adapter,
                syncAdapter: args.syncAdapter,
                syncEnabled: args.syncEnabled,
                idempotencyTtlMs: args.idempotencyTtlMs,
                resource,
                action,
                items,
                writeOptions,
                opTrace,
                logger: args.pluginRuntime.logger
            })

            return {
                ok: true,
                data: {
                    transactionApplied: execution.transactionApplied,
                    results: execution.results
                }
            }
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
