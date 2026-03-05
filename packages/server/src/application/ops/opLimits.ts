import type { QueryOp, WriteOp } from '@atoma-js/types/protocol'
import type { AtomaServerConfig } from '../../config'
import { byteLengthUtf8, throwError } from '../../error'
import type { ServerRuntime } from '../../runtime/createRuntime'
import { clampQueryLimit } from './normalize'

function baseLimitDetails(runtime: ServerRuntime<any>) {
    return {
        ...(runtime.traceId ? { traceId: runtime.traceId } : {}),
        ...(runtime.requestId ? { requestId: runtime.requestId } : {})
    }
}

export function assertUniqueOpIds(ops: Array<{ opId: string }>) {
    const seen = new Set<string>()
    for (const op of ops) {
        if (seen.has(op.opId)) {
            throwError('INVALID_REQUEST', `Duplicate opId: ${op.opId}`, { kind: 'validation', opId: op.opId })
        }
        seen.add(op.opId)
    }
}

export function applyOpsLimits<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    runtime: ServerRuntime<Ctx>
    ops: Array<QueryOp | WriteOp>
    queryOps: QueryOp[]
    writeOps: WriteOp[]
}) {
    const limits = args.config.limits
    const runtimeDetails = baseLimitDetails(args.runtime)

    if (limits?.batch?.maxOps && args.ops.length > limits.batch.maxOps) {
        throwError('INVALID_REQUEST', `Too many ops: max ${limits.batch.maxOps}`, {
            kind: 'limits',
            max: limits.batch.maxOps,
            actual: args.ops.length,
            ...runtimeDetails
        })
    }

    if (limits?.query?.maxQueries && args.queryOps.length > limits.query.maxQueries) {
        throwError('TOO_MANY_QUERIES', `Too many queries: max ${limits.query.maxQueries}`, {
            kind: 'limits',
            max: limits.query.maxQueries,
            actual: args.queryOps.length,
            ...runtimeDetails
        })
    }

    if (limits?.query?.maxLimit) {
        args.queryOps.forEach(op => {
            clampQueryLimit(op.query.query, limits.query!.maxLimit!)
        })
    }

    args.writeOps.forEach(op => {
        const entries = Array.isArray(op.write.entries) ? op.write.entries : []

        if (limits?.write?.maxBatchSize && entries.length > limits.write.maxBatchSize) {
            throwError('TOO_MANY_ITEMS', `Too many items: max ${limits.write.maxBatchSize}`, {
                kind: 'limits',
                max: limits.write.maxBatchSize,
                actual: entries.length,
                ...runtimeDetails,
                opId: op.opId
            } as any)
        }

        if (limits?.write?.maxPayloadBytes) {
            const size = byteLengthUtf8(JSON.stringify(entries ?? ''))
            if (size > limits.write.maxPayloadBytes) {
                throwError('PAYLOAD_TOO_LARGE', `Payload too large: max ${limits.write.maxPayloadBytes} bytes`, {
                    kind: 'limits',
                    max: limits.write.maxPayloadBytes,
                    actual: size,
                    ...runtimeDetails,
                    opId: op.opId
                } as any)
            }
        }
    })
}
