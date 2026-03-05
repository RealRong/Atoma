import { throwError } from '../../error'
import type {
    AtomaServerMiddleware,
    AtomaServerConfig,
    AtomaServerRoute
} from '../../config'
import type { ServerRuntime } from '../../runtime/createRuntime'
import type { IOrmAdapter, ISyncAdapter } from '../../adapters/ports'
import type { QueryOp, RemoteOpResult, WriteOp } from '@atoma-js/types/protocol'
import { composeEnvelopeOk, createErrorFromCode, withErrorTrace } from '@atoma-js/types/protocol-tools'
import { ensureProtocolVersion, normalizeRemoteOpsRequest } from './normalize'
import { executeApplicationQueryOps } from './executeQueryOps'
import { executeApplicationWriteOps } from './executeWriteOps'
import { applyOpsLimits, assertUniqueOpIds } from './opLimits'
import { createOpMiddlewareRunner } from './opMiddleware'
import { collectOpTrace } from './opTrace'

type ExecuteOpsArgs<Ctx> = {
    config: AtomaServerConfig<Ctx>
    adapter: IOrmAdapter
    syncAdapter?: ISyncAdapter
    syncEnabled: boolean
    idempotencyTtlMs: number
    opMiddlewares: Array<NonNullable<AtomaServerMiddleware<Ctx>['onOp']>>
    readBodyJson: (incoming: any) => Promise<any>
    incoming: any
    method: string
    runtime: ServerRuntime<Ctx>
}

export async function executeApplicationOps<Ctx>(args: ExecuteOpsArgs<Ctx>): Promise<{ status: number; body: any; headers?: Record<string, string> }> {
    if (args.method !== 'POST') {
        throwError('METHOD_NOT_ALLOWED', 'POST required', {
            kind: 'validation',
            traceId: args.runtime.traceId,
            requestId: args.runtime.requestId
        })
    }

    const bodyRaw = await args.readBodyJson(args.incoming)
    const req = normalizeRemoteOpsRequest(bodyRaw)
    ensureProtocolVersion(req.meta)

    const ops = req.ops
    const queryOps = ops.filter((op): op is QueryOp => op.kind === 'query')
    const writeOps = ops.filter((op): op is WriteOp => op.kind === 'write')

    const traceMetaForOpId = collectOpTrace(ops)
    assertUniqueOpIds(ops)
    applyOpsLimits({ config: args.config, runtime: args.runtime, ops, queryOps, writeOps })

    const route: AtomaServerRoute = { kind: 'ops' }
    const pluginRuntime = {
        ctx: args.runtime.ctx as Ctx,
        traceId: args.runtime.traceId,
        requestId: args.runtime.requestId,
        logger: args.runtime.logger
    }
    const runOpMiddlewares = createOpMiddlewareRunner(args.opMiddlewares)

    const resultsByOpId = new Map<string, RemoteOpResult>()

    await executeApplicationQueryOps({
        adapter: args.adapter,
        queryOps,
        hasOpMiddlewares: Boolean(args.opMiddlewares.length),
        route,
        pluginRuntime,
        runOpMiddlewares,
        traceMetaForOpId,
        resultsByOpId
    })

    await executeApplicationWriteOps({
        adapter: args.adapter,
        syncAdapter: args.syncAdapter,
        syncEnabled: args.syncEnabled,
        idempotencyTtlMs: args.idempotencyTtlMs,
        writeOps,
        route,
        pluginRuntime,
        runOpMiddlewares,
        traceMetaForOpId,
        resultsByOpId
    })

    const results: RemoteOpResult[] = ops.map(op => {
        const result = resultsByOpId.get(op.opId)
        if (result) return result

        return {
            opId: op.opId,
            ok: false,
            error: withErrorTrace(
                createErrorFromCode('INTERNAL', 'Missing result'),
                traceMetaForOpId(op.opId)
            )
        }
    })

    return {
        status: 200,
        body: composeEnvelopeOk(
            { results },
            {
                v: 1,
                serverTimeMs: Date.now(),
                ...(req.meta.deviceId ? { deviceId: req.meta.deviceId } : {})
            }
        )
    }
}
