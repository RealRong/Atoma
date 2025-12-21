import type { AtomaServerConfig, AtomaServerRoute } from '../../config'
import type { BatchOp, BatchRequest, IOrmAdapter } from '../../types'
import { parseHttp } from '../../parser/parseHttp'
import { validateAndNormalizeRequest } from '../../validator/validator'
import { executeRequest } from '../../executor/executor'
import { enforceQueryFieldPolicy, resolveFieldPolicy } from '../../guard/fieldPolicy'
import { toRestResponse } from '../../routes/rest/toRestResponse'
import type { LimitPolicy } from '../../policies/limitPolicy'
import type { HandleResult } from '../../http/types'
import { handleWithRuntime } from '../../engine/handleWithRuntime'
import type { CreateRuntime, FormatTopLevelError } from '../../engine/types'
import type { AuthzPolicy } from '../../policies/authzPolicy'
import { fieldPolicyForResource } from '../../authz/fieldPolicyForResource'
import { mergeForcedWhere } from '../../authz/mergeForcedWhere'
import { validateWriteForOp } from './validateWriteForOp'
import type { BatchRestService } from '../types'
import { Protocol } from '#protocol'

function resolveResource(op: BatchOp): string {
    return op.action === 'query' ? op.query.resource : (op as any).resource
}

export function createBatchRestService<Ctx>(args: {
    config: AtomaServerConfig<Ctx>
    authz: AuthzPolicy<Ctx>
    limits: LimitPolicy<Ctx>
    batchPath: string
    restEnabled: boolean
    traceHeader: string
    requestHeader: string
    syncEnabled: boolean
    createRuntime: CreateRuntime<Ctx>
    formatTopLevelError: FormatTopLevelError<Ctx>
}): BatchRestService<Ctx> {
    return {
        handleHttp: async (ctx) => {
            const parsed = await parseHttp(
                { ...ctx.incoming, url: ctx.urlForParse ?? ctx.urlRaw },
                {
                    batchPath: args.batchPath,
                    enableRest: args.restEnabled,
                    traceIdHeader: args.traceHeader,
                    requestIdHeader: args.requestHeader,
                    bodyReader: (inc: any) => args.limits.readBodyJson(inc)
                } as any
            )

            if (parsed.ok === 'pass') {
                return {
                    status: 404,
                    body: Protocol.http.compose.error(Protocol.error.create('NOT_FOUND', 'No route matched'))
                }
            }
            if (parsed.ok === false) {
                return { status: parsed.httpStatus, body: Protocol.http.compose.error(parsed.error) }
            }

            const route: AtomaServerRoute = parsed.route.kind === 'batch'
                ? { kind: 'batch' }
                : { kind: 'rest', method: parsed.route.method, resource: parsed.route.resource ?? '', ...(parsed.route.id ? { id: parsed.route.id } : {}) }

            const initialTraceId = typeof (parsed.request as any)?.traceId === 'string' ? (parsed.request as any).traceId : undefined
            const initialRequestId = typeof (parsed.request as any)?.requestId === 'string' ? (parsed.request as any).requestId : undefined

            return handleWithRuntime<Ctx>({
                incoming: ctx.incoming,
                route,
                method: ctx.method,
                pathname: ctx.pathname,
                initialTraceId,
                initialRequestId,
                createRuntime: args.createRuntime,
                formatTopLevelError: args.formatTopLevelError,
                run: async (runtime, phase) => {
                    const { traceId, requestId, ctx: userCtx } = runtime

                    const request = validateAndNormalizeRequest(parsed.request) as BatchRequest
                    if (traceId) (request as any).traceId = traceId
                    if (requestId) (request as any).requestId = requestId

                    await phase.validated({ request, event: { opCount: request.ops.length } })

                    args.limits.validateBatchRequest(request, { traceId, requestId })
                    const queryOps = request.ops.filter(op => op.action === 'query')

                    for (const op of request.ops) {
                        const resource = resolveResource(op)
                        if (typeof resource === 'string' && resource) {
                            args.authz.ensureResourceAllowed(resource, { traceId, requestId })
                        }
                    }

                    for (let i = 0; i < queryOps.length; i++) {
                        const op = queryOps[i]
                        const resource = op.query.resource
                        const input = fieldPolicyForResource(args.config, resource)
                        const policy = resolveFieldPolicy(input, {
                            action: op.action,
                            resource,
                            params: op.query.params,
                            ctx: userCtx,
                            request,
                            queryIndex: i
                        })
                        enforceQueryFieldPolicy(resource, op.query.params, policy, { queryIndex: i, traceId, requestId, opId: op.opId })
                    }

                    await Promise.all(request.ops.map(async (op) => {
                        const resource = resolveResource(op)

                        if (op.action === 'query') {
                            const forced = await args.authz.filterQuery({
                                resource,
                                params: op.query.params,
                                op,
                                route,
                                runtime
                            })
                            forced.forEach(w => mergeForcedWhere(op.query.params, w))

                            await args.authz.authorize({
                                action: 'query',
                                resource,
                                op,
                                route,
                                runtime
                            })
                            return
                        }

                        await args.authz.authorize({
                            action: 'write',
                            resource,
                            op,
                            route,
                            runtime
                        })

                        await validateWriteForOp({ config: args.config, route, op: op as any, runtime, authz: args.authz })
                    }))

                    await phase.authorized()

                    const response = await executeRequest(
                        request,
                        { orm: args.config.adapter.orm as IOrmAdapter, ...(args.syncEnabled ? { sync: args.config.adapter.sync } : {}) },
                        {
                            syncEnabled: args.syncEnabled,
                            idempotencyTtlMs: args.config.sync?.push?.idempotencyTtlMs ?? 7 * 24 * 60 * 60 * 1000
                        }
                    )
                    runtime.observabilityContext.emit('server:response', { ok: true })

                    if (parsed.route.kind === 'rest') {
                        return toRestResponse(parsed.route, request, response)
                    }

                    return { status: 200, body: response }
                }
            })
        }
    }
}
