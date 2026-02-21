import type { Entity } from 'atoma-types/core'
import type {
    ExecutionBundle,
    ExecutionErrorCode,
    ExecutionEvent,
    ExecutionKernel as ExecutionKernelType,
    ExecutionOptions,
    QueryRequest,
    ExecutionQueryOutput,
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
    KernelSnapshot
} from './kernelTypes'
import { resolveExecution } from './resolver'

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

function normalizeExecutionOptions({
    options
}: {
    options?: ExecutionOptions
}): ExecutionOptions | undefined {
    const signal = options?.signal
    if (signal === undefined) {
        return undefined
    }

    return { signal }
}

export class ExecutionKernel implements ExecutionKernelType {
    private layers: KernelLayer[] = []
    private snapshot: KernelSnapshot = {}
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
        _handle: StoreHandle<T>,
        options?: ExecutionOptions
    ): WriteConsistency => {
        normalizeExecutionOptions({ options })
        const resolved = resolveExecution({
            snapshot: this.snapshot,
            phase: 'write',
            createError: this.createError
        })
        if (!resolved) return ExecutionKernel.DEFAULT_CONSISTENCY

        return {
            ...ExecutionKernel.DEFAULT_CONSISTENCY,
            ...resolved.spec.consistency
        }
    }

    hasExecutor = (phase: KernelPhase): boolean => {
        return this.snapshot[phase] !== undefined
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
        options
    }: {
        phase: KernelPhase
        request: Request
        options?: ExecutionOptions
    }): Promise<Output> => {
        const normalizedOptions = normalizeExecutionOptions({
            options
        })
        const resolved = resolveExecution({
            snapshot: this.snapshot,
            phase,
            createError: this.createError
        })
        if (!resolved) {
            throw this.createError({
                code: 'E_EXECUTOR_MISSING',
                message: `[Atoma] execution: 未注册 ${phase} executor`,
                retryable: false,
                details: { phase }
            })
        }
        const meta = KERNEL_PHASE_META[phase]
        const eventBase = {
            executor: resolved.resolution.executor,
            resolution: resolved.resolution,
            request,
            options: normalizedOptions
        }

        this.events.emit({
            type: meta.dispatched,
            ...eventBase
        } as ExecutionEvent)

        try {
            const executor = phase === 'query'
                ? resolved.spec.query as ((request: Request, options?: ExecutionOptions) => Promise<Output>) | undefined
                : resolved.spec.write as ((request: Request, options?: ExecutionOptions) => Promise<Output>) | undefined
            if (!executor) {
                throw this.createError({
                    code: phase === 'query'
                        ? 'E_EXECUTOR_QUERY_UNIMPLEMENTED'
                        : 'E_EXECUTOR_WRITE_UNIMPLEMENTED',
                    message: phase === 'query'
                        ? `[Atoma] execution.query: executor 未实现 query: ${resolved.resolution.executor}`
                        : `[Atoma] execution.write: executor 未实现 write: ${resolved.resolution.executor}`,
                    retryable: false,
                    details: { executor: resolved.resolution.executor }
                })
            }
            const output = await executor(request, normalizedOptions)
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
                    executor: resolved.resolution.executor,
                    phase
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
            options
        })
    }

    write = async <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions): Promise<WriteOutput> => {
        return await this.executePhase({
            phase: 'write',
            request,
            options
        })
    }
}
