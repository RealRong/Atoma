import type { ExecutionRoute } from 'atoma-types/core'
import type {
    Consistency,
    ExecutionResolution,
    ExecutionSpec,
    ExecutorId,
    RouteSpec
} from 'atoma-types/runtime'

export type KernelPhase = 'query' | 'write'

export type KernelLayer = Readonly<{
    token: symbol
    id: string
    executors: ReadonlyMap<ExecutorId, ExecutionSpec>
    routes: ReadonlyMap<ExecutionRoute, RouteSpec>
    defaultRoute?: ExecutionRoute
}>

export type KernelSnapshot = Readonly<{
    executors: ReadonlyMap<ExecutorId, ExecutionSpec>
    routes: ReadonlyMap<ExecutionRoute, RouteSpec>
    defaultRoute?: ExecutionRoute
}>

export type KernelResolvedExecution = Readonly<{
    resolution: ExecutionResolution
    spec: ExecutionSpec
    consistency: Consistency
}>
