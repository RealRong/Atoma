import { readJsonBodyWithLimit, byteLengthUtf8 } from '../http/body'
import { throwError } from '../error'
import type { AtomaServerConfig } from '../config'
import type { BatchRequest } from '../types'
import type { SyncPushRequest } from '#protocol'

export type LimitMeta = {
    traceId?: string
    requestId?: string
}

export type LimitPolicy<Ctx> = {
    readBodyJson: (incoming: any) => Promise<any>
    validateBatchRequest: (request: BatchRequest, meta: LimitMeta) => void
    validateSyncPushRequest: (request: SyncPushRequest, meta: LimitMeta) => void
}

export function createLimitPolicy<Ctx>(config: AtomaServerConfig<Ctx>): LimitPolicy<Ctx> {
    return {
        readBodyJson: async (incoming) => {
            return readJsonBodyWithLimit(incoming, config.limits?.bodyBytes)
        },
        validateBatchRequest: (request, meta) => {
            const limits = config.limits
            const queryOps = request.ops.filter(op => op.action === 'query')

            if (limits?.query?.maxQueries && queryOps.length > limits.query.maxQueries) {
                throwError('TOO_MANY_QUERIES', `Too many queries: max ${limits.query.maxQueries}`, {
                    kind: 'limits',
                    max: limits.query.maxQueries,
                    actual: queryOps.length,
                    ...(meta.traceId ? { traceId: meta.traceId } : {}),
                    ...(meta.requestId ? { requestId: meta.requestId } : {})
                })
            }

            if (limits?.query?.maxLimit) {
                for (const op of queryOps) {
                    const page = (op.query.params as any).page
                    if (!page || typeof page !== 'object') continue
                    if (page.mode === 'offset' || page.mode === 'cursor') {
                        if (typeof page.limit === 'number' && page.limit > limits.query.maxLimit) {
                            page.limit = limits.query.maxLimit
                        }
                    }
                }
            }

            if (limits?.batch?.maxOps && request.ops.length > limits.batch.maxOps) {
                throwError('INVALID_REQUEST', `Too many ops: max ${limits.batch.maxOps}`, {
                    kind: 'limits',
                    max: limits.batch.maxOps,
                    actual: request.ops.length,
                    ...(meta.traceId ? { traceId: meta.traceId } : {}),
                    ...(meta.requestId ? { requestId: meta.requestId } : {})
                })
            }

            for (const op of request.ops) {
                if (op.action === 'query') continue

                const payloadArr = Array.isArray((op as any).payload) ? (op as any).payload : []
                if (limits?.write?.maxBatchSize && payloadArr.length > limits.write.maxBatchSize) {
                    throwError('TOO_MANY_ITEMS', `Too many items: max ${limits.write.maxBatchSize}`, {
                        kind: 'limits',
                        max: limits.write.maxBatchSize,
                        actual: payloadArr.length,
                        ...(meta.traceId ? { traceId: meta.traceId } : {}),
                        ...(meta.requestId ? { requestId: meta.requestId } : {})
                    })
                }

                if (limits?.write?.maxPayloadBytes && (op as any).payload !== undefined) {
                    const size = byteLengthUtf8(JSON.stringify((op as any).payload ?? ''))
                    if (size > limits.write.maxPayloadBytes) {
                        throwError('PAYLOAD_TOO_LARGE', `Payload too large: max ${limits.write.maxPayloadBytes} bytes`, {
                            kind: 'limits',
                            max: limits.write.maxPayloadBytes,
                            actual: size,
                            ...(meta.traceId ? { traceId: meta.traceId } : {}),
                            ...(meta.requestId ? { requestId: meta.requestId } : {})
                        })
                    }
                }
            }
        },
        validateSyncPushRequest: (request, meta) => {
            const maxOps = config.sync?.push?.maxOps ?? config.limits?.syncPush?.maxOps ?? 2000
            if (request.ops.length > maxOps) {
                throwError('TOO_MANY_ITEMS', `Too many ops: max ${maxOps}`, {
                    kind: 'limits',
                    max: maxOps,
                    actual: request.ops.length,
                    ...(meta.traceId ? { traceId: meta.traceId } : {}),
                    ...(meta.requestId ? { requestId: meta.requestId } : {})
                })
            }
        }
    }
}
