import type { ExecutionRoute } from 'atoma-types/core'
import type { CreateExecutionError } from './errors'
import type {
    KernelPhase,
    KernelResolvedExecution,
    KernelSnapshot
} from './kernelTypes'

type ResolveExecutionArgs = Readonly<{
    snapshot: KernelSnapshot
    phase: KernelPhase
    route?: ExecutionRoute
    createError: CreateExecutionError
}>

export function resolveExecution({
    snapshot,
    phase,
    route,
    createError
}: ResolveExecutionArgs): KernelResolvedExecution | undefined {
    const routeId = String(route ?? '').trim() || snapshot.defaultRoute
    if (!routeId) return undefined

    const routeSpec = snapshot.routes.get(routeId)
    if (!routeSpec) {
        throw createError({
            code: 'E_ROUTE_NOT_FOUND',
            message: `[Atoma] execution: route 未注册: ${routeId}`,
            retryable: false,
            details: { route: routeId }
        })
    }

    const executor = phase === 'query'
        ? routeSpec.query
        : routeSpec.write
    const spec = snapshot.executors.get(executor)
    if (!spec) {
        throw createError({
            code: 'E_EXECUTOR_NOT_FOUND',
            message: `[Atoma] execution: executor 未注册: ${executor}`,
            retryable: false,
            details: { route: routeId, executor, phase }
        })
    }

    return {
        resolution: {
            route: routeId,
            executor
        },
        spec,
        consistency: {
            ...(routeSpec.consistency ?? {}),
            ...(spec.consistency ?? {})
        }
    }
}
