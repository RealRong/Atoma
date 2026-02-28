import type { AtomaServerConfig, AtomaServerRoute } from '../../config'
import { executeApplicationOps } from '../../application/ops/executeOps'
import { executeApplicationPull } from '../../application/sync/executePull'
import { executeApplicationPush } from '../../application/sync/executePush'
import { executeApplicationStream } from '../../application/sync/executeStream'
import { handleResultToResponse, toIncoming } from '../../entry/response'
import { createRuntimeRunner } from '../../entry/runWithRuntime'
import { createRuntimeFactory } from '../../runtime/createRuntime'
import { createTopLevelErrorFormatter } from '../../runtime/errors'
import { readJsonBodyWithLimit } from '../../runtime/http'
import { normalizeServerConfig } from './configNormalization'
import { createMiddlewareRunners, createRouteHandler } from './routeHandlers'

export function createAtomaHandlers<Ctx = unknown>(rawConfig: AtomaServerConfig<Ctx>) {
    const config = normalizeServerConfig(rawConfig)
    const syncEnabled = config.sync?.enabled ?? true
    const idempotencyTtlMs = config.sync?.push?.idempotencyTtlMs ?? 7 * 24 * 60 * 60 * 1000
    const readBodyJson = (incoming: any) => readJsonBodyWithLimit(incoming, config.limits?.bodyBytes)
    const runWithRuntime = createRuntimeRunner<Ctx>({
        createRuntime: createRuntimeFactory({ config }),
        formatTopLevelError: createTopLevelErrorFormatter(config)
    })
    const { opMiddlewares, runRequestMiddlewares, runResponseMiddlewares, runErrorMiddlewares } = createMiddlewareRunners(
        Array.isArray(config.middleware) ? config.middleware : []
    )

    const createHandler = (
        route: AtomaServerRoute,
        withTraceQuery: boolean,
        runUseCase: (args: {
            request: Request
            urlObj: URL
            method: string
            runtime: any
        }) => Promise<Response>
    ) => createRouteHandler({
        route,
        withTraceQuery,
        runWithRuntime,
        runRequestMiddlewares,
        runResponseMiddlewares,
        runErrorMiddlewares,
        runUseCase
    })

    return {
        ops: createHandler(
            { kind: 'ops' },
            false,
            async ({ request, method, runtime }) => {
                const result = await executeApplicationOps({
                    config,
                    adapter: config.adapter.orm as any,
                    syncAdapter: config.adapter.sync,
                    syncEnabled,
                    idempotencyTtlMs,
                    opMiddlewares,
                    readBodyJson,
                    incoming: toIncoming(request),
                    method,
                    runtime
                })
                return handleResultToResponse(result)
            }
        ),
        syncRxdbPull: createHandler(
            { kind: 'sync-rxdb-pull' },
            true,
            async ({ request, method, runtime }) => {
                const result = await executeApplicationPull({
                    config,
                    readBodyJson,
                    incoming: toIncoming(request),
                    method,
                    runtime
                })
                return handleResultToResponse(result)
            }
        ),
        syncRxdbPush: createHandler(
            { kind: 'sync-rxdb-push' },
            true,
            async ({ request, method, runtime }) => {
                const result = await executeApplicationPush({
                    config,
                    readBodyJson,
                    incoming: toIncoming(request),
                    method,
                    runtime
                })
                return handleResultToResponse(result)
            }
        ),
        syncRxdbStream: createHandler(
            { kind: 'sync-rxdb-stream' },
            true,
            async ({ request, urlObj, method, runtime }) => {
                const result = await executeApplicationStream({
                    config,
                    incoming: toIncoming(request),
                    urlObj,
                    method,
                    runtime
                })
                return handleResultToResponse(result)
            }
        )
    }
}
