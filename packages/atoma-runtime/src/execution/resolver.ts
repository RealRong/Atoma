import type {
    ExecutionResolution,
    ExecutionSpec,
    ExecutorId,
    RouteId
} from 'atoma-types/runtime'
import type { CreateExecutionError } from './errors'
import type {
    KernelPhase,
    KernelResolvedExecution,
    KernelSnapshot
} from './kernelTypes'

function normalize(value: unknown): string {
    return String(value ?? '').trim()
}

type ResolveExecutionBase = Readonly<{
    snapshot: KernelSnapshot
    phase: KernelPhase
    route?: RouteId
    createError: CreateExecutionError
}>

type ResolveExecutionRequired = ResolveExecutionBase & Readonly<{
    required: true
}>

type ResolveExecutionOptional = ResolveExecutionBase & Readonly<{
    required: false
}>

export function resolveExecution(args: ResolveExecutionRequired): KernelResolvedExecution
export function resolveExecution(args: ResolveExecutionOptional): KernelResolvedExecution | undefined
export function resolveExecution({
    snapshot,
    phase,
    route,
    required,
    createError
}: ResolveExecutionBase & Readonly<{
    required: boolean
}>): KernelResolvedExecution | undefined {
    const explicitRoute = normalize(route)
    const resolveByRoute = (
        routeId: RouteId,
        source: ExecutionResolution['source']
    ): KernelResolvedExecution => {
        const routeSpec = snapshot.routes.get(routeId)
        if (!routeSpec) {
            throw createError({
                code: 'E_ROUTE_NOT_FOUND',
                message: `[Atoma] execution: route 未注册: ${routeId}`,
                retryable: false,
                details: { route: routeId, source }
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
            route: routeId,
            executor,
            routeSpec,
            resolution: {
                source,
                route: routeId,
                executor,
                trace: [executor]
            },
            spec
        }
    }

    if (explicitRoute) return resolveByRoute(explicitRoute, 'explicit-route')
    if (snapshot.defaultRoute) return resolveByRoute(snapshot.defaultRoute, 'default-route')
    if (!required) return undefined

    throw createError({
        code: 'E_ROUTE_NOT_FOUND',
        message: '[Atoma] execution: 未配置默认 route',
        retryable: false,
        details: { source: 'default-route' }
    })
}

export function resolveQueryExecutor({
    executor,
    spec,
    createError
}: {
    executor: ExecutorId
    spec: ExecutionSpec
    createError: CreateExecutionError
}): NonNullable<ExecutionSpec['query']> {
    if (!spec.query) {
        throw createError({
            code: 'E_EXECUTOR_QUERY_UNIMPLEMENTED',
            message: `[Atoma] execution.query: executor 未实现 query: ${executor}`,
            retryable: false,
            details: { executor }
        })
    }
    return spec.query
}

export function resolveWriteExecutor({
    executor,
    spec,
    createError
}: {
    executor: ExecutorId
    spec: ExecutionSpec
    createError: CreateExecutionError
}): NonNullable<ExecutionSpec['write']> {
    if (!spec.write) {
        throw createError({
            code: 'E_EXECUTOR_WRITE_UNIMPLEMENTED',
            message: `[Atoma] execution.write: executor 未实现 write: ${executor}`,
            retryable: false,
            details: { executor }
        })
    }
    return spec.write
}
