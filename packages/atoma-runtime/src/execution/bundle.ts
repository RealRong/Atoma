import type {
    ExecutionBundle,
    ExecutionSpec,
    ExecutorId,
    RouteId,
    RouteSpec
} from 'atoma-types/runtime'
import type { CreateExecutionError } from './errors'
import type { KernelLayer, KernelSnapshot } from './kernelTypes'

function normalize(value: unknown): string {
    return String(value ?? '').trim()
}

type NormalizedBundle = Omit<KernelLayer, 'token'>

export function normalizeBundle({
    bundle,
    createError
}: {
    bundle: ExecutionBundle
    createError: CreateExecutionError
}): NormalizedBundle {
    const id = normalize(bundle.id)
    if (!id) {
        throw createError({
            code: 'E_EXECUTION_BUNDLE_INVALID',
            message: '[Atoma] execution.apply: bundle.id 必填',
            retryable: false
        })
    }

    const executors = new Map<ExecutorId, ExecutionSpec>()
    Object.entries(bundle.executors ?? {}).forEach(([rawExecutorId, spec]) => {
        const executorId = normalize(rawExecutorId)
        if (!executorId) {
            throw createError({
                code: 'E_EXECUTION_BUNDLE_INVALID',
                message: '[Atoma] execution.apply: executor id 必填',
                retryable: false,
                details: { layerId: id }
            })
        }
        executors.set(executorId, spec)
    })

    const routes = new Map<RouteId, RouteSpec>()
    Object.entries(bundle.routes ?? {}).forEach(([rawRouteId, spec]) => {
        const routeId = normalize(rawRouteId)
        if (!routeId) {
            throw createError({
                code: 'E_ROUTE_INVALID',
                message: '[Atoma] execution.apply: route id 必填',
                retryable: false,
                details: { layerId: id }
            })
        }

        const query = normalize(spec?.query)
        const write = normalize(spec?.write)
        if (!query || !write) {
            throw createError({
                code: 'E_ROUTE_INVALID',
                message: `[Atoma] execution.apply: route 配置缺失 query/write: ${routeId}`,
                retryable: false,
                details: { layerId: id, route: routeId }
            })
        }

        routes.set(routeId, {
            ...spec,
            query,
            write
        })
    })

    const defaultRoute = normalize(bundle.defaultRoute)
    return {
        id,
        executors,
        routes,
        ...(defaultRoute ? { defaultRoute } : {})
    }
}

export function buildSnapshot({
    layers,
    createError
}: {
    layers: ReadonlyArray<KernelLayer>
    createError: CreateExecutionError
}): KernelSnapshot {
    const executors = new Map<ExecutorId, ExecutionSpec>()
    const routes = new Map<RouteId, RouteSpec>()
    let defaultRoute: RouteId | undefined

    layers.forEach((layer) => {
        layer.executors.forEach((spec, executorId) => {
            if (executors.has(executorId)) {
                throw createError({
                    code: 'E_EXECUTION_CONFLICT',
                    message: `[Atoma] execution.apply: executor 冲突: ${executorId}`,
                    retryable: false,
                    details: { executor: executorId, layerId: layer.id }
                })
            }
            executors.set(executorId, spec)
        })

        layer.routes.forEach((route, routeId) => {
            if (routes.has(routeId)) {
                throw createError({
                    code: 'E_EXECUTION_CONFLICT',
                    message: `[Atoma] execution.apply: route 冲突: ${routeId}`,
                    retryable: false,
                    details: { route: routeId, layerId: layer.id }
                })
            }
            routes.set(routeId, route)
        })

        defaultRoute = layer.defaultRoute ?? defaultRoute
    })

    routes.forEach((route, routeId) => {
        if (!executors.has(route.query)) {
            throw createError({
                code: 'E_EXECUTOR_NOT_FOUND',
                message: `[Atoma] execution.apply: route.query 未注册 executor: ${routeId} -> ${route.query}`,
                retryable: false,
                details: { route: routeId, phase: 'query', executor: route.query }
            })
        }
        if (!executors.has(route.write)) {
            throw createError({
                code: 'E_EXECUTOR_NOT_FOUND',
                message: `[Atoma] execution.apply: route.write 未注册 executor: ${routeId} -> ${route.write}`,
                retryable: false,
                details: { route: routeId, phase: 'write', executor: route.write }
            })
        }
    })

    if (defaultRoute && !routes.has(defaultRoute)) {
        throw createError({
            code: 'E_ROUTE_NOT_FOUND',
            message: `[Atoma] execution.apply: defaultRoute 未注册: ${defaultRoute}`,
            retryable: false,
            details: { route: defaultRoute, source: 'default-route' }
        })
    }

    return {
        executors,
        routes,
        ...(defaultRoute ? { defaultRoute } : {})
    }
}
