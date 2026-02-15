import type { Entity } from 'atoma-types/core'
import { createCodedError, isCodedError } from 'atoma-shared'
import type {
    ExecutionBundle,
    ExecutionError,
    ExecutionErrorCode,
    ExecutionEvent,
    ExecutionKernel as ExecutionKernelType,
    ExecutionOptions,
    ExecutorId,
    ExecutionResolution,
    ExecutionSpec,
    WriteConsistency,
    QueryRequest,
    QueryOutput,
    RouteId,
    RouteSpec,
    WriteRequest,
    WriteOutput
} from 'atoma-types/runtime'
import { ExecutionEvents } from '../events'

function normalize(value: unknown): string {
    return String(value ?? '').trim()
}

type KernelPhase = 'query' | 'write'

type KernelLayer = Readonly<{
    token: symbol
    id: string
    executors: ReadonlyMap<ExecutorId, ExecutionSpec>
    routes: ReadonlyMap<RouteId, RouteSpec>
    defaultRoute?: RouteId
}>

type KernelSnapshot = Readonly<{
    executors: ReadonlyMap<ExecutorId, ExecutionSpec>
    routes: ReadonlyMap<RouteId, RouteSpec>
    defaultRoute?: RouteId
}>

type KernelResolvedExecution = Readonly<{
    route: RouteId
    executor: ExecutorId
    routeSpec: RouteSpec
    resolution: ExecutionResolution
    spec: ExecutionSpec
}>

export class ExecutionKernel implements ExecutionKernelType {
    private layers: KernelLayer[] = []
    private snapshot: KernelSnapshot = {
        executors: new Map<ExecutorId, ExecutionSpec>(),
        routes: new Map<RouteId, RouteSpec>()
    }
    private readonly events = new ExecutionEvents()

    private static readonly DEFAULT_CONSISTENCY: WriteConsistency = {
        base: 'fetch',
        commit: 'optimistic'
    }

    private createExecutionError = (args: {
        code: ExecutionErrorCode
        message: string
        retryable?: boolean
        details?: Readonly<Record<string, unknown>>
        cause?: unknown
    }): ExecutionError => {
        return createCodedError({
            code: args.code,
            message: args.message,
            retryable: args.retryable,
            details: args.details,
            cause: args.cause
        }) as ExecutionError
    }

    private normalizeExecutionError = (args: {
        error: unknown
        fallbackCode: ExecutionErrorCode
        fallbackMessage: string
        retryable?: boolean
        details?: Readonly<Record<string, unknown>>
    }): ExecutionError => {
        if (isCodedError(args.error)) {
            return args.error as ExecutionError
        }
        return this.createExecutionError({
            code: args.fallbackCode,
            message: args.fallbackMessage,
            retryable: args.retryable,
            details: args.details,
            cause: args.error
        })
    }

    private normalizeBundle = (bundle: ExecutionBundle): Omit<KernelLayer, 'token'> => {
        const id = normalize(bundle.id)
        if (!id) {
            throw this.createExecutionError({
                code: 'E_EXECUTION_BUNDLE_INVALID',
                message: '[Atoma] execution.apply: bundle.id 必填',
                retryable: false
            })
        }

        const executors = new Map<ExecutorId, ExecutionSpec>()
        const rawExecutors = bundle.executors ?? {}
        for (const [rawExecutorId, spec] of Object.entries(rawExecutors)) {
            const executorId = normalize(rawExecutorId)
            if (!executorId) {
                throw this.createExecutionError({
                    code: 'E_EXECUTION_BUNDLE_INVALID',
                    message: '[Atoma] execution.apply: executor id 必填',
                    retryable: false,
                    details: { layerId: id }
                })
            }
            executors.set(executorId, spec)
        }

        const routes = new Map<RouteId, RouteSpec>()
        const rawRoutes = bundle.routes ?? {}
        for (const [rawRouteId, spec] of Object.entries(rawRoutes)) {
            const routeId = normalize(rawRouteId)
            if (!routeId) {
                throw this.createExecutionError({
                    code: 'E_ROUTE_INVALID',
                    message: '[Atoma] execution.apply: route id 必填',
                    retryable: false,
                    details: { layerId: id }
                })
            }
            const query = normalize(spec?.query)
            const write = normalize(spec?.write)
            if (!query || !write) {
                throw this.createExecutionError({
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
        }

        const defaultRoute = normalize(bundle.defaultRoute)

        return {
            id,
            executors,
            routes,
            ...(defaultRoute ? { defaultRoute } : {})
        }
    }

    private buildSnapshot = (layers: ReadonlyArray<KernelLayer>): KernelSnapshot => {
        const executors = new Map<ExecutorId, ExecutionSpec>()
        const routes = new Map<RouteId, RouteSpec>()
        let defaultRoute: RouteId | undefined

        for (const layer of layers) {
            for (const [executorId, spec] of layer.executors.entries()) {
                if (executors.has(executorId)) {
                    throw this.createExecutionError({
                        code: 'E_EXECUTION_CONFLICT',
                        message: `[Atoma] execution.apply: executor 冲突: ${executorId}`,
                        retryable: false,
                        details: { executor: executorId, layerId: layer.id }
                    })
                }
                executors.set(executorId, spec)
            }

            for (const [routeId, route] of layer.routes.entries()) {
                if (routes.has(routeId)) {
                    throw this.createExecutionError({
                        code: 'E_EXECUTION_CONFLICT',
                        message: `[Atoma] execution.apply: route 冲突: ${routeId}`,
                        retryable: false,
                        details: { route: routeId, layerId: layer.id }
                    })
                }
                routes.set(routeId, route)
            }

            if (layer.defaultRoute) {
                defaultRoute = layer.defaultRoute
            }
        }

        for (const [routeId, route] of routes.entries()) {
            if (!executors.has(route.query)) {
                throw this.createExecutionError({
                    code: 'E_EXECUTOR_NOT_FOUND',
                    message: `[Atoma] execution.apply: route.query 未注册 executor: ${routeId} -> ${route.query}`,
                    retryable: false,
                    details: { route: routeId, phase: 'query', executor: route.query }
                })
            }
            if (!executors.has(route.write)) {
                throw this.createExecutionError({
                    code: 'E_EXECUTOR_NOT_FOUND',
                    message: `[Atoma] execution.apply: route.write 未注册 executor: ${routeId} -> ${route.write}`,
                    retryable: false,
                    details: { route: routeId, phase: 'write', executor: route.write }
                })
            }
        }

        if (defaultRoute && !routes.has(defaultRoute)) {
            throw this.createExecutionError({
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

    apply = (bundle: ExecutionBundle): (() => void) => {
        const normalized = this.normalizeBundle(bundle)
        const layer: KernelLayer = {
            token: Symbol(normalized.id),
            ...normalized
        }

        const previousLayers = this.layers

        const nextLayers = [...previousLayers, layer]
        const nextSnapshot = this.buildSnapshot(nextLayers)

        this.layers = nextLayers
        this.snapshot = nextSnapshot

        return () => {
            const currentIndex = this.layers.findIndex(item => item.token === layer.token)
            if (currentIndex < 0) return

            const rollbackLayers = [
                ...this.layers.slice(0, currentIndex),
                ...this.layers.slice(currentIndex + 1)
            ]
            this.layers = rollbackLayers
            this.snapshot = this.buildSnapshot(rollbackLayers)
        }
    }

    resolveConsistency = (route?: RouteId): WriteConsistency => {
        const resolved = this.resolveExecution({
            phase: 'write',
            route,
            required: false
        })
        if (!resolved) return ExecutionKernel.DEFAULT_CONSISTENCY

        const routeConsistency = resolved.routeSpec.consistency
        const executorConsistency = this.snapshot.executors.get(resolved.executor)?.consistency
        return {
            ...ExecutionKernel.DEFAULT_CONSISTENCY,
            ...(routeConsistency ?? {}),
            ...(executorConsistency ?? {})
        }
    }

    subscribe = (listener: (event: ExecutionEvent) => void): (() => void) => {
        return this.events.subscribe(listener)
    }

    private resolveExecution = (args: {
        phase: KernelPhase
        route?: RouteId
        required: boolean
    }): KernelResolvedExecution | undefined => {
        const explicitRoute = normalize(args.route)

        const resolveByRoute = (routeId: RouteId, source: ExecutionResolution['source']): KernelResolvedExecution => {
            const routeSpec = this.snapshot.routes.get(routeId)
            if (!routeSpec) {
                throw this.createExecutionError({
                    code: 'E_ROUTE_NOT_FOUND',
                    message: `[Atoma] execution: route 未注册: ${routeId}`,
                    retryable: false,
                    details: { route: routeId, source }
                })
            }

            const executor = args.phase === 'query'
                ? routeSpec.query
                : routeSpec.write
            const spec = this.snapshot.executors.get(executor)
            if (!spec) {
                throw this.createExecutionError({
                    code: 'E_EXECUTOR_NOT_FOUND',
                    message: `[Atoma] execution: executor 未注册: ${executor}`,
                    retryable: false,
                    details: { route: routeId, executor, phase: args.phase }
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

        if (explicitRoute) {
            return resolveByRoute(explicitRoute, 'explicit-route')
        }

        const defaultRoute = this.snapshot.defaultRoute
        if (defaultRoute) {
            return resolveByRoute(defaultRoute, 'default-route')
        }

        if (!args.required) return undefined
        throw this.createExecutionError({
            code: 'E_ROUTE_NOT_FOUND',
            message: '[Atoma] execution: 未配置默认 route',
            retryable: false,
            details: { source: 'default-route' }
        })
    }

    private resolveQueryExecutor = (executor: ExecutorId, spec: ExecutionSpec): NonNullable<ExecutionSpec['query']> => {
        if (!spec.query) {
            throw this.createExecutionError({
                code: 'E_EXECUTOR_QUERY_UNIMPLEMENTED',
                message: `[Atoma] execution.query: executor 未实现 query: ${executor}`,
                retryable: false,
                details: { executor }
            })
        }
        return spec.query
    }

    private resolveWriteExecutor = (executor: ExecutorId, spec: ExecutionSpec): NonNullable<ExecutionSpec['write']> => {
        if (!spec.write) {
            throw this.createExecutionError({
                code: 'E_EXECUTOR_WRITE_UNIMPLEMENTED',
                message: `[Atoma] execution.write: executor 未实现 write: ${executor}`,
                retryable: false,
                details: { executor }
            })
        }
        return spec.write
    }

    query = async <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions): Promise<QueryOutput> => {
        const resolved = this.resolveExecution({
            phase: 'query',
            route: options?.route,
            required: true
        })
        if (!resolved) {
            throw this.createExecutionError({
                code: 'E_ROUTE_NOT_FOUND',
                message: '[Atoma] execution.query: route 解析失败',
                retryable: false
            })
        }

        this.events.emit({
            type: 'query.dispatched',
            route: resolved.route,
            executor: resolved.executor,
            resolution: resolved.resolution,
            request,
            options
        })

        const query = this.resolveQueryExecutor(resolved.executor, resolved.spec)

        try {
            const output = await query(request, options)
            this.events.emit({
                type: 'query.succeeded',
                route: resolved.route,
                executor: resolved.executor,
                resolution: resolved.resolution,
                request,
                options,
                output
            })
            return output
        } catch (error) {
            const normalizedError = this.normalizeExecutionError({
                error,
                fallbackCode: 'E_EXECUTION_QUERY_FAILED',
                fallbackMessage: '[Atoma] execution.query failed',
                retryable: false,
                details: {
                    route: resolved.route,
                    executor: resolved.executor
                }
            })
            this.events.emit({
                type: 'query.failed',
                route: resolved.route,
                executor: resolved.executor,
                resolution: resolved.resolution,
                request,
                options,
                error: normalizedError
            })
            throw normalizedError
        }
    }

    write = async <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions): Promise<WriteOutput<T>> => {
        const resolved = this.resolveExecution({
            phase: 'write',
            route: options?.route,
            required: true
        })
        if (!resolved) {
            throw this.createExecutionError({
                code: 'E_ROUTE_NOT_FOUND',
                message: '[Atoma] execution.write: route 解析失败',
                retryable: false
            })
        }

        this.events.emit({
            type: 'write.dispatched',
            route: resolved.route,
            executor: resolved.executor,
            resolution: resolved.resolution,
            request,
            options
        })

        const write = this.resolveWriteExecutor(resolved.executor, resolved.spec)

        try {
            const output = await write(request, options)
            this.events.emit({
                type: 'write.succeeded',
                route: resolved.route,
                executor: resolved.executor,
                resolution: resolved.resolution,
                request,
                options,
                output
            })
            return output
        } catch (error) {
            const normalizedError = this.normalizeExecutionError({
                error,
                fallbackCode: 'E_EXECUTION_WRITE_FAILED',
                fallbackMessage: '[Atoma] execution.write failed',
                retryable: false,
                details: {
                    route: resolved.route,
                    executor: resolved.executor
                }
            })
            this.events.emit({
                type: 'write.failed',
                route: resolved.route,
                executor: resolved.executor,
                resolution: resolved.resolution,
                request,
                options,
                error: normalizedError
            })
            throw normalizedError
        }
    }
}
