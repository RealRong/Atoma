import type {
    ExecutionResolution,
    ExecutionSpec,
    ExecutorId,
    RouteId,
    RouteSpec
} from 'atoma-types/runtime'

export type KernelPhase = 'query' | 'write'

export type KernelLayer = Readonly<{
    token: symbol
    id: string
    executors: ReadonlyMap<ExecutorId, ExecutionSpec>
    routes: ReadonlyMap<RouteId, RouteSpec>
    defaultRoute?: RouteId
}>

export type KernelSnapshot = Readonly<{
    executors: ReadonlyMap<ExecutorId, ExecutionSpec>
    routes: ReadonlyMap<RouteId, RouteSpec>
    defaultRoute?: RouteId
}>

export type KernelResolvedExecution = Readonly<{
    route: RouteId
    executor: ExecutorId
    routeSpec: RouteSpec
    resolution: ExecutionResolution
    spec: ExecutionSpec
}>
