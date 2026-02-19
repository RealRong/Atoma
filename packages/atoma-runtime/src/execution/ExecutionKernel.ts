import type { Entity } from 'atoma-types/core'
import type {
    ExecutionBundle,
    ExecutionErrorCode,
    ExecutionEvent,
    ExecutionKernel as ExecutionKernelType,
    ExecutionOptions,
    QueryRequest,
    ExecutionQueryOutput,
    RouteId,
    StoreHandle,
    WriteConsistency,
    WriteRequest,
    WriteOutput
} from 'atoma-types/runtime'
import { buildSnapshot, normalizeBundle } from './bundle'
import { ExecutionEvents } from './ExecutionEvents'
import {
    createExecutionError,
    normalizeExecutionError,
    type CreateExecutionError
} from './errors'
import type {
    KernelLayer,
    KernelPhase,
    KernelResolvedExecution,
    KernelSnapshot
} from './kernelTypes'
import {
    resolveExecution,
    resolveQueryExecutor,
    resolveWriteExecutor
} from './resolver'

type KernelPhaseMeta = Readonly<{
    dispatched: ExecutionEvent['type']
    succeeded: ExecutionEvent['type']
    failed: ExecutionEvent['type']
    fallbackCode: ExecutionErrorCode
    fallbackMessage: string
}>

const KERNEL_PHASE_META: Readonly<Record<KernelPhase, KernelPhaseMeta>> = {
    query: {
        dispatched: 'query.dispatched',
        succeeded: 'query.succeeded',
        failed: 'query.failed',
        fallbackCode: 'E_EXECUTION_QUERY_FAILED',
        fallbackMessage: '[Atoma] execution.query failed'
    },
    write: {
        dispatched: 'write.dispatched',
        succeeded: 'write.succeeded',
        failed: 'write.failed',
        fallbackCode: 'E_EXECUTION_WRITE_FAILED',
        fallbackMessage: '[Atoma] execution.write failed'
    }
}

function normalizeExecutionOptions(args: {
    options?: ExecutionOptions
    defaultRoute?: RouteId
}): ExecutionOptions | undefined {
    const route = args.options?.route ?? args.defaultRoute
    const signal = args.options?.signal
    if (route === undefined && signal === undefined) {
        return undefined
    }

    return {
        ...(route !== undefined ? { route } : {}),
        ...(signal !== undefined ? { signal } : {})
    }
}

export class ExecutionKernel implements ExecutionKernelType {
    private layers: KernelLayer[] = []
    private snapshot: KernelSnapshot = {
        executors: new Map(),
        routes: new Map()
    }
    private readonly events = new ExecutionEvents()
    private readonly createError: CreateExecutionError = createExecutionError

    private static readonly DEFAULT_CONSISTENCY: WriteConsistency = {
        base: 'fetch',
        commit: 'optimistic'
    }

    apply = (bundle: ExecutionBundle): (() => void) => {
        const normalized = normalizeBundle({
            bundle,
            createError: this.createError
        })
        const layer: KernelLayer = {
            token: Symbol(normalized.id),
            ...normalized
        }

        const nextLayers = [...this.layers, layer]
        this.layers = nextLayers
        this.snapshot = buildSnapshot({
            layers: nextLayers,
            createError: this.createError
        })

        return () => {
            const index = this.layers.findIndex((item) => item.token === layer.token)
            if (index < 0) return

            const rollbackLayers = [
                ...this.layers.slice(0, index),
                ...this.layers.slice(index + 1)
            ]
            this.layers = rollbackLayers
            this.snapshot = buildSnapshot({
                layers: rollbackLayers,
                createError: this.createError
            })
        }
    }

    resolveConsistency = <T extends Entity>(
        handle: StoreHandle<T>,
        options?: ExecutionOptions
    ): WriteConsistency => {
        const normalizedOptions = normalizeExecutionOptions({
            options,
            defaultRoute: handle.config.defaultRoute
        })
        const resolved = resolveExecution({
            snapshot: this.snapshot,
            phase: 'write',
            route: normalizedOptions?.route,
            required: false,
            createError: this.createError
        })
        if (!resolved) return ExecutionKernel.DEFAULT_CONSISTENCY

        return {
            ...ExecutionKernel.DEFAULT_CONSISTENCY,
            ...(resolved.routeSpec.consistency ?? {}),
            ...(resolved.spec.consistency ?? {})
        }
    }

    subscribe = (listener: (event: ExecutionEvent) => void): (() => void) => {
        return this.events.subscribe(listener)
    }

    private executePhase = async <
        Request,
        Output
    >({
        phase,
        request,
        options,
        defaultRoute,
        resolveExecutor
    }: {
        phase: KernelPhase
        request: Request
        options?: ExecutionOptions
        defaultRoute?: RouteId
        resolveExecutor: (resolved: KernelResolvedExecution) => (
            request: Request,
            options?: ExecutionOptions
        ) => Promise<Output>
    }): Promise<Output> => {
        const normalizedOptions = normalizeExecutionOptions({
            options,
            defaultRoute
        })
        const resolved = resolveExecution({
            snapshot: this.snapshot,
            phase,
            route: normalizedOptions?.route,
            required: true,
            createError: this.createError
        })
        const meta = KERNEL_PHASE_META[phase]
        const eventBase = {
            route: resolved.route,
            executor: resolved.executor,
            resolution: resolved.resolution,
            request,
            options: normalizedOptions
        }

        this.events.emit({
            type: meta.dispatched,
            ...eventBase
        } as ExecutionEvent)

        try {
            const output = await resolveExecutor(resolved)(request, normalizedOptions)
            this.events.emit({
                type: meta.succeeded,
                ...eventBase,
                output
            } as ExecutionEvent)
            return output
        } catch (error) {
            const normalizedError = normalizeExecutionError({
                error,
                fallbackCode: meta.fallbackCode,
                fallbackMessage: meta.fallbackMessage,
                retryable: false,
                details: {
                    route: resolved.route,
                    executor: resolved.executor
                },
                createError: this.createError
            })
            this.events.emit({
                type: meta.failed,
                ...eventBase,
                error: normalizedError
            } as ExecutionEvent)
            throw normalizedError
        }
    }

    query = async <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions): Promise<ExecutionQueryOutput<T>> => {
        return await this.executePhase({
            phase: 'query',
            request,
            options,
            defaultRoute: request.handle.config.defaultRoute,
            resolveExecutor: (resolved) => resolveQueryExecutor({
                executor: resolved.executor,
                spec: resolved.spec,
                createError: this.createError
            })
        })
    }

    write = async <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions): Promise<WriteOutput<T>> => {
        return await this.executePhase({
            phase: 'write',
            request,
            options,
            defaultRoute: request.handle.config.defaultRoute,
            resolveExecutor: (resolved) => resolveWriteExecutor({
                executor: resolved.executor,
                spec: resolved.spec,
                createError: this.createError
            })
        })
    }
}
