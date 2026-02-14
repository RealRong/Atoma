import type { Entity } from 'atoma-types/core'
import type {
    ExecutionBundle,
    ExecutionEvent,
    ExecutionKernel as ExecutionKernelType,
    ExecutorId,
    RouteId,
    RouteSpec,
    ExecutionResolution,
    ExecutionSpec,
    Policy,
    QueryInput,
    QueryOutput,
    WriteInput,
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
    allowOverride: boolean
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

    private static readonly DEFAULT_POLICY: Policy = {
        implicitFetch: true,
        optimistic: true
    }

    private normalizeBundle = (bundle: ExecutionBundle): Omit<KernelLayer, 'token'> => {
        const id = normalize(bundle.id)
        if (!id) throw new Error('[Atoma] execution.apply: bundle.id 必填')

        const executors = new Map<ExecutorId, ExecutionSpec>()
        const rawExecutors = bundle.executors ?? {}
        for (const [rawExecutorId, spec] of Object.entries(rawExecutors)) {
            const executorId = normalize(rawExecutorId)
            if (!executorId) {
                throw new Error('[Atoma] execution.apply: executor id 必填')
            }
            executors.set(executorId, spec)
        }

        const routes = new Map<RouteId, RouteSpec>()
        const rawRoutes = bundle.routes ?? {}
        for (const [rawRouteId, spec] of Object.entries(rawRoutes)) {
            const routeId = normalize(rawRouteId)
            if (!routeId) {
                throw new Error('[Atoma] execution.apply: route id 必填')
            }
            const query = normalize(spec?.query)
            const write = normalize(spec?.write)
            if (!query || !write) {
                throw new Error(`[Atoma] execution.apply: route 配置缺失 query/write: ${routeId}`)
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
            ...(defaultRoute ? { defaultRoute } : {}),
            allowOverride: bundle.allowOverride === true
        }
    }

    private buildSnapshot = (layers: ReadonlyArray<KernelLayer>): KernelSnapshot => {
        const executors = new Map<ExecutorId, ExecutionSpec>()
        const routes = new Map<RouteId, RouteSpec>()
        let defaultRoute: RouteId | undefined

        for (const layer of layers) {
            for (const [executorId, spec] of layer.executors.entries()) {
                if (executors.has(executorId) && !layer.allowOverride) {
                    throw new Error(`[Atoma] execution.apply: executor 冲突: ${executorId}`)
                }
                executors.set(executorId, spec)
            }

            for (const [routeId, route] of layer.routes.entries()) {
                if (routes.has(routeId) && !layer.allowOverride) {
                    throw new Error(`[Atoma] execution.apply: route 冲突: ${routeId}`)
                }
                routes.set(routeId, route)
            }

            if (layer.defaultRoute) {
                defaultRoute = layer.defaultRoute
            }
        }

        for (const [routeId, route] of routes.entries()) {
            if (!executors.has(route.query)) {
                throw new Error(`[Atoma] execution.apply: route.query 未注册 executor: ${routeId} -> ${route.query}`)
            }
            if (!executors.has(route.write)) {
                throw new Error(`[Atoma] execution.apply: route.write 未注册 executor: ${routeId} -> ${route.write}`)
            }
        }

        if (defaultRoute && !routes.has(defaultRoute)) {
            throw new Error(`[Atoma] execution.apply: defaultRoute 未注册: ${defaultRoute}`)
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

    resolvePolicy = (route?: RouteId): Policy => {
        const resolved = this.resolveExecution({
            phase: 'write',
            route,
            required: false
        })
        if (!resolved) return ExecutionKernel.DEFAULT_POLICY

        const routePolicy = resolved.routeSpec.policy
        const executorPolicy = this.snapshot.executors.get(resolved.executor)?.policy
        return {
            ...ExecutionKernel.DEFAULT_POLICY,
            ...(routePolicy ?? {}),
            ...(executorPolicy ?? {})
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
                throw new Error(`[Atoma] execution: route 未注册: ${routeId}`)
            }

            const executor = args.phase === 'query'
                ? routeSpec.query
                : routeSpec.write
            const spec = this.snapshot.executors.get(executor)
            if (!spec) {
                throw new Error(`[Atoma] execution: executor 未注册: ${executor}`)
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
        throw new Error('[Atoma] execution: 未配置默认 route')
    }

    private resolveQueryExecutor = (executor: ExecutorId, spec: ExecutionSpec): NonNullable<ExecutionSpec['query']> => {
        if (!spec.query) {
            throw new Error(`[Atoma] execution.query: executor 未实现 query: ${executor}`)
        }
        return spec.query
    }

    private resolveWriteExecutor = (executor: ExecutorId, spec: ExecutionSpec): NonNullable<ExecutionSpec['write']> => {
        if (!spec.write) {
            throw new Error(`[Atoma] execution.write: executor 未实现 write: ${executor}`)
        }
        return spec.write
    }

    query = async <T extends Entity>(input: QueryInput<T>): Promise<QueryOutput> => {
        const resolved = this.resolveExecution({
            phase: 'query',
            required: true
        })
        if (!resolved) {
            throw new Error('[Atoma] execution.query: route 解析失败')
        }

        this.events.emit({
            type: 'query.dispatched',
            route: resolved.route,
            executor: resolved.executor,
            resolution: resolved.resolution,
            input
        })

        const query = this.resolveQueryExecutor(resolved.executor, resolved.spec)

        try {
            const output = await query(input)
            this.events.emit({
                type: 'query.succeeded',
                route: resolved.route,
                executor: resolved.executor,
                resolution: resolved.resolution,
                input,
                output
            })
            return output
        } catch (error) {
            this.events.emit({
                type: 'query.failed',
                route: resolved.route,
                executor: resolved.executor,
                resolution: resolved.resolution,
                input,
                error
            })
            throw error
        }
    }

    write = async <T extends Entity>(input: WriteInput<T>): Promise<WriteOutput<T>> => {
        const resolved = this.resolveExecution({
            phase: 'write',
            route: input.route,
            required: true
        })
        if (!resolved) {
            throw new Error('[Atoma] execution.write: route 解析失败')
        }

        this.events.emit({
            type: 'write.dispatched',
            route: resolved.route,
            executor: resolved.executor,
            resolution: resolved.resolution,
            input
        })

        const write = this.resolveWriteExecutor(resolved.executor, resolved.spec)

        try {
            const output = await write(input)
            this.events.emit({
                type: 'write.succeeded',
                route: resolved.route,
                executor: resolved.executor,
                resolution: resolved.resolution,
                input,
                output
            })
            return output
        } catch (error) {
            this.events.emit({
                type: 'write.failed',
                route: resolved.route,
                executor: resolved.executor,
                resolution: resolved.resolution,
                input,
                error
            })
            throw error
        }
    }
}
