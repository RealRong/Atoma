import { toStandardError, throwError } from '../../error'
import { validateSyncPullQuery, validateSyncPushRequest, validateSyncSubscribeQuery } from '../../sync/validation'
import type { AtomaServerConfig, AtomaServerRoute } from '../../config'
import type { HandleResult } from '../../http/types'
import type { ServerRuntime } from '../../engine/runtime'
import type { PhaseReporter } from '../../engine/types'
import type { AuthzPolicy } from '../../policies/authzPolicy'
import type { LimitPolicy } from '../../policies/limitPolicy'
import { executeWriteItemWithSemantics } from '../../writeSemantics/executeWriteItemWithSemantics'
import { summarizeCreateItem, summarizePatches } from '../../writeSummary'
import { createGetCurrent } from '../shared/createGetCurrent'
import type { SyncService } from '../types'

export function createSyncService<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    authz: AuthzPolicy<Ctx>
    limits: LimitPolicy<Ctx>
}): SyncService<Ctx> {
    const makeSubscribeStream = (mode: 'legacy' | 'vnext') => {
        return async function* stream(args2: {
            incoming: any
            startCursor: number
            route: AtomaServerRoute
            runtime: ServerRuntime<Ctx>
            heartbeatMs: number
            retryMs: number
            maxHoldMs: number
        }) {
            let cursor = args2.startCursor
            let lastBeat = Date.now()

            yield `retry: ${args2.retryMs}\n\n`

            const allowCache = new Map<string, boolean>()

            while (true) {
                if (args2.incoming?.signal?.aborted === true) return

                const now = Date.now()
                if (now - lastBeat >= args2.heartbeatMs) {
                    lastBeat = now
                    yield `:hb\n\n`
                }

                const changes = await args.config.adapter.sync!.waitForChanges(cursor, args2.maxHoldMs)
                if (!changes.length) continue

                const filtered = await args.authz.filterChanges({
                    changes,
                    route: args2.route,
                    runtime: args2.runtime,
                    allowCache
                })

                const nextCursor = changes[changes.length - 1].cursor
                cursor = nextCursor

                if (!filtered.length) continue

                yield `event: changes\n`
                if (mode === 'legacy') {
                    yield `data: ${JSON.stringify({ cursor: nextCursor, changes: filtered })}\n\n`
                    continue
                }

                yield `data: ${JSON.stringify({
                    nextCursor: String(nextCursor),
                    changes: filtered.map((c: any) => ({
                        resource: c.resource,
                        entityId: c.id,
                        kind: c.kind,
                        version: c.serverVersion,
                        changedAtMs: c.changedAt
                    }))
                })}\n\n`
            }
        }
    }

    const legacySubscribeStream = makeSubscribeStream('legacy')
    const vnextSubscribeStream = makeSubscribeStream('vnext')

    return {
        pull: async ({ urlObj, method, route, runtime, phase }) => {
            if (method !== 'GET') {
                throwError('METHOD_NOT_ALLOWED', 'GET required', { kind: 'validation', traceId: runtime.traceId, requestId: runtime.requestId })
            }

            const defaultLimit = args.config.sync?.pull?.defaultLimit ?? 200
            const maxLimit = args.config.sync?.pull?.maxLimit ?? 200
            const { cursor, limit } = validateSyncPullQuery({
                cursor: urlObj.searchParams.get('cursor'),
                limit: urlObj.searchParams.get('limit'),
                defaultLimit,
                maxLimit
            })

            await phase.validated({ request: { cursor, limit }, event: { cursor, limit } })

            const raw = await args.config.adapter.sync!.pullChanges(cursor, limit)
            const filtered = await args.authz.filterChanges({
                changes: raw,
                route,
                runtime
            })

            const nextCursor = raw.length ? raw[raw.length - 1].cursor : cursor
            const body = { nextCursor, changes: filtered }
            return { status: 200, body }
        },

        subscribe: async ({ incoming, urlObj, method, route, runtime, phase }) => {
            if (method !== 'GET') {
                throwError('METHOD_NOT_ALLOWED', 'GET required', { kind: 'validation', traceId: runtime.traceId, requestId: runtime.requestId })
            }

            const { cursor: startCursor } = validateSyncSubscribeQuery({
                cursor: urlObj.searchParams.get('cursor')
            })

            await phase.validated({ request: { cursor: startCursor }, event: { cursor: startCursor } })

            const heartbeatMs = args.config.sync?.subscribe?.heartbeatMs ?? 15000
            const retryMs = args.config.sync?.subscribe?.retryMs ?? 2000
            const maxHoldMs = args.config.sync?.subscribe?.maxHoldMs ?? 30000

            const headers = {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive'
            }

            return {
                status: 200,
                headers,
                body: legacySubscribeStream({
                    incoming,
                    startCursor,
                    route,
                    runtime,
                    heartbeatMs,
                    retryMs,
                    maxHoldMs
                })
            }
        },

        subscribeVNext: async ({ incoming, urlObj, method, route, runtime, phase }) => {
            if (method !== 'GET') {
                throwError('METHOD_NOT_ALLOWED', 'GET required', { kind: 'validation', traceId: runtime.traceId, requestId: runtime.requestId })
            }

            const { cursor: startCursor } = validateSyncSubscribeQuery({
                cursor: urlObj.searchParams.get('cursor')
            })

            await phase.validated({ request: { cursor: startCursor }, event: { cursor: startCursor } })

            const heartbeatMs = args.config.sync?.subscribe?.heartbeatMs ?? 15000
            const retryMs = args.config.sync?.subscribe?.retryMs ?? 2000
            const maxHoldMs = args.config.sync?.subscribe?.maxHoldMs ?? 30000

            const headers = {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive'
            }

            return {
                status: 200,
                headers,
                body: vnextSubscribeStream({
                    incoming,
                    startCursor,
                    route,
                    runtime,
                    heartbeatMs,
                    retryMs,
                    maxHoldMs
                })
            }
        },

        preparePush: async ({ incoming, traceIdHeaderValue, requestIdHeaderValue }) => {
            const bodyRaw = await args.limits.readBodyJson(incoming)
            const request = validateSyncPushRequest(bodyRaw)
            const initialTraceId = traceIdHeaderValue || (typeof request.traceId === 'string' ? request.traceId : undefined)
            const initialRequestId = requestIdHeaderValue || (typeof request.requestId === 'string' ? request.requestId : undefined)

            return { request, initialTraceId, initialRequestId }
        },

        push: async ({ method, route, request, runtime, phase }) => {
            if (method !== 'POST') {
                throwError('METHOD_NOT_ALLOWED', 'POST required', { kind: 'validation', traceId: runtime.traceId, requestId: runtime.requestId })
            }

            await phase.validated({ request, event: { opCount: request.ops.length } })

            args.limits.validateSyncPushRequest(request, { traceId: runtime.traceId, requestId: runtime.requestId })

            const acked: any[] = []
            const rejected: any[] = []
            let serverCursor: number | undefined
            const txHostRaw = args.config.adapter.orm.transaction
            if (typeof txHostRaw !== 'function') {
                throw new Error('AtomaServerConfig.adapter.orm.transaction is required for /sync/push')
            }
            const txHost = txHostRaw.bind(args.config.adapter.orm)
            const idempotencyTtlMs = args.config.sync?.push?.idempotencyTtlMs ?? 7 * 24 * 60 * 60 * 1000

            for (const op of request.ops) {
                try {
                    args.authz.ensureResourceAllowed(op.resource, { traceId: runtime.traceId, requestId: runtime.requestId })
                } catch (err) {
                    rejected.push({ idempotencyKey: op.idempotencyKey, error: toStandardError(err, 'ACCESS_DENIED') })
                    continue
                }

                try {
                    await args.authz.authorize({ action: 'sync', resource: op.resource, op, route, runtime })
                } catch (err) {
                    rejected.push({ idempotencyKey: op.idempotencyKey, error: toStandardError(err, 'ACCESS_DENIED') })
                    continue
                }

                try {
                    const makeGetCurrent = createGetCurrent(args.config.adapter.orm, op.resource)

                    if (op.kind === 'create') {
                        const summary = summarizeCreateItem((op as any).data)
                        await args.authz.validateWrite({
                            resource: op.resource,
                            op,
                            item: (op as any).data,
                            changedFields: summary.changedFields,
                            ...(Array.isArray(summary.changedPaths) ? { changedPaths: summary.changedPaths } : {}),
                            getCurrent: async () => undefined,
                            route,
                            runtime
                        })
                    } else if (op.kind === 'patch') {
                        const summary = summarizePatches((op as any).patches)
                        await args.authz.validateWrite({
                            resource: op.resource,
                            op,
                            item: op,
                            changedFields: summary.changedFields,
                            ...(Array.isArray(summary.changedPaths) ? { changedPaths: summary.changedPaths } : {}),
                            getCurrent: makeGetCurrent((op as any).id),
                            route,
                            runtime
                        })
                    } else {
                        await args.authz.validateWrite({
                            resource: op.resource,
                            op,
                            item: op,
                            changedFields: [],
                            getCurrent: makeGetCurrent((op as any).id),
                            route,
                            runtime
                        })
                    }
                } catch (err) {
                    rejected.push({ idempotencyKey: op.idempotencyKey, error: toStandardError(err, 'ACCESS_DENIED') })
                    continue
                }

                try {
                    const result = await txHost(async (tx) => {
                        return executeWriteItemWithSemantics({
                            orm: tx.orm,
                            sync: args.config.adapter.sync,
                            tx: tx.tx,
                            syncEnabled: true,
                            idempotencyTtlMs,
                            meta: { traceId: runtime.traceId, requestId: runtime.requestId },
                            write: {
                                kind: (op as any).kind,
                                resource: op.resource,
                                idempotencyKey: op.idempotencyKey,
                                ...((op as any).kind === 'create' ? { id: (op as any).id, data: (op as any).data } : {}),
                                ...((op as any).kind === 'patch' ? { id: (op as any).id, patches: (op as any).patches, baseVersion: (op as any).baseVersion, timestamp: (op as any).timestamp } : {}),
                                ...((op as any).kind === 'delete' ? { id: (op as any).id, baseVersion: (op as any).baseVersion } : {})
                            } as any
                        })
                    })

                    if (result.ok) {
                        const replay = result.replay
                        const cursor = (replay as any)?.cursor ?? (result.change ? result.change.cursor : undefined)
                        const ack = {
                            idempotencyKey: op.idempotencyKey,
                            resource: replay.resource,
                            id: replay.id,
                            serverVersion: replay.serverVersion
                        }
                        acked.push(ack)
                        if (typeof cursor === 'number') {
                            serverCursor = Math.max(serverCursor ?? 0, cursor)
                        }
                        continue
                    }

                    const replay = result.replay
                    const reject = {
                        idempotencyKey: op.idempotencyKey,
                        error: result.error,
                        ...(replay && (replay as any).kind === 'error' && (replay as any).currentValue !== undefined
                            ? { currentValue: (replay as any).currentValue }
                            : {}),
                        ...(replay && (replay as any).kind === 'error' && typeof (replay as any).currentVersion === 'number'
                            ? { currentVersion: (replay as any).currentVersion }
                            : {})
                    }
                    rejected.push(reject)
                } catch (err: any) {
                    const debug = typeof process !== 'undefined'
                        && process?.env
                        && (process.env.ATOMA_DEBUG_ERRORS === '1' || process.env.ATOMA_DEBUG_ERRORS === 'true')
                    if (debug) {
                        // eslint-disable-next-line no-console
                        console.error('[atoma] /sync/push write failed', {
                            traceId: runtime.traceId,
                            requestId: runtime.requestId,
                            idempotencyKey: op.idempotencyKey,
                            resource: op.resource,
                            kind: (op as any).kind,
                            id: (op as any).id,
                            baseVersion: (op as any).baseVersion,
                            timestamp: (op as any).timestamp
                        }, err)
                    }
                    const standard = toStandardError(err, 'WRITE_FAILED')
                    const conflictVersion = (standard.details as any)?.currentVersion
                    const conflictValue = (standard.details as any)?.currentValue
                    rejected.push({
                        idempotencyKey: op.idempotencyKey,
                        error: standard,
                        ...(conflictValue !== undefined ? { currentValue: conflictValue } : {}),
                        ...(typeof conflictVersion === 'number' ? { currentVersion: conflictVersion } : {})
                    })
                }
            }

            return { status: 200, body: { ...(serverCursor !== undefined ? { serverCursor } : {}), acked, rejected } }
        }
    }
}
