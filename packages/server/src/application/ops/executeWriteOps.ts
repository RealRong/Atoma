import pLimit from 'p-limit'
import { withErrorTrace } from '@atoma-js/types/tools'
import type { RemoteOpResult, WriteOp } from '@atoma-js/types/protocol'
import type {
    AtomaOpMiddlewareContext,
    AtomaOpMiddlewareResult,
    AtomaServerPluginRuntime,
    AtomaServerRoute
} from '../../config'
import type { IOrmAdapter, ISyncAdapter } from '../../adapters/ports'
import { toStandard } from '../../shared/errors/standardError'
import { isDeepEqual } from '../../shared/utils/object'
import { executeWriteItems } from './writeItemExecutor'
import {
    serializeErrorForLog,
    type TraceMeta
} from './writeResult'

function readWriteOpEntries(op: WriteOp): {
    resource: string
    action: 'create' | 'update' | 'upsert' | 'delete'
    items: any[]
    writeOptions: unknown
} {
    const resource = op.write.resource
    const entries = Array.isArray(op.write.entries) ? op.write.entries : []
    const action = entries.length ? entries[0]?.action : undefined

    if (action !== 'create' && action !== 'update' && action !== 'upsert' && action !== 'delete') {
        throw new Error('Invalid write action')
    }
    if (entries.some(entry => entry.action !== action)) {
        throw new Error('Mixed write actions in one op are not supported')
    }

    const firstOptions = entries.length ? (entries[0] as any)?.options : undefined
    if (entries.some(entry => !isDeepEqual((entry as any)?.options ?? null, firstOptions ?? null))) {
        throw new Error('Mixed write options in one op are not supported')
    }

    return {
        resource,
        action,
        items: entries.map(entry => entry.item),
        writeOptions: firstOptions
    }
}

export async function executeApplicationWriteOps<Ctx>(args: {
    adapter: IOrmAdapter
    syncAdapter?: ISyncAdapter
    syncEnabled: boolean
    idempotencyTtlMs: number
    writeOps: WriteOp[]
    route: AtomaServerRoute
    pluginRuntime: AtomaServerPluginRuntime<Ctx>
    runOpMiddlewares: (
        ctx: AtomaOpMiddlewareContext<Ctx>,
        next: () => Promise<AtomaOpMiddlewareResult>
    ) => Promise<AtomaOpMiddlewareResult>
    traceMetaForOpId: (opId: string) => TraceMeta
    resultsByOpId: Map<string, RemoteOpResult>
}) {
    if (!args.writeOps.length) return

    const limit = pLimit(8)

    await Promise.all(args.writeOps.map(op => limit(async () => {
        const opTrace = args.traceMetaForOpId(op.opId)
        const { resource, action, items, writeOptions } = readWriteOpEntries(op)

        const middlewareResult = await args.runOpMiddlewares({
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

        if (middlewareResult.ok) {
            args.resultsByOpId.set(op.opId, { opId: op.opId, ok: true, data: middlewareResult.data })
            return
        }

        args.pluginRuntime.logger?.error?.('write op failed', {
            opId: opTrace.opId,
            ...(opTrace.traceId ? { traceId: opTrace.traceId } : {}),
            ...(opTrace.requestId ? { requestId: opTrace.requestId } : {}),
            resource,
            action,
            error: serializeErrorForLog(middlewareResult.error)
        })
        const standard = withErrorTrace(toStandard(middlewareResult.error, 'WRITE_FAILED'), opTrace)
        args.resultsByOpId.set(op.opId, { opId: op.opId, ok: false, error: standard })
    })))
}
