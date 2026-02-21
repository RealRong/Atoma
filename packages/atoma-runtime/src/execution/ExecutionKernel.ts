import type { Entity } from 'atoma-types/core'
import type {
    ExecutionKernel as ExecutionKernelType,
    ExecutionOptions,
    ExecutionRegistration,
    QueryRequest,
    ExecutionQueryOutput,
    WriteConsistency,
    WriteRequest,
    WriteOutput
} from 'atoma-types/runtime'
import {
    createExecutionError,
    normalizeExecutionError,
    type CreateExecutionError
} from './errors'

type KernelPhase = 'query' | 'write'

type RegisteredExecutor = Readonly<{
    token: symbol
    id: string
    registration: ExecutionRegistration
}>

export class ExecutionKernel implements ExecutionKernelType {
    private readonly slots: Partial<Record<KernelPhase, RegisteredExecutor>> = {}
    private readonly createError: CreateExecutionError = createExecutionError
    private anonymousIdCounter = 0

    private static readonly DEFAULT_CONSISTENCY: WriteConsistency = {
        base: 'fetch',
        commit: 'optimistic'
    }

    private createAnonymousId = (phases: ReadonlyArray<KernelPhase>): string => {
        this.anonymousIdCounter += 1
        return `anonymous-${phases.join('-') || 'executor'}-${this.anonymousIdCounter}`
    }

    register = (registration: ExecutionRegistration): (() => void) => {
        const phases: KernelPhase[] = [
            typeof registration.query === 'function' ? 'query' : undefined,
            typeof registration.write === 'function' ? 'write' : undefined
        ].filter((phase): phase is KernelPhase => phase !== undefined)
        const id = String(registration.id ?? '').trim()
        if (!phases.length) {
            throw this.createError({
                code: 'E_EXECUTION_REGISTER_INVALID',
                message: `[Atoma] execution.register: 至少实现 query/write 之一: ${id || '[anonymous]'}`,
                retryable: false
            })
        }
        const normalized: ExecutionRegistration & { id: string } = {
            ...registration,
            id: id || this.createAnonymousId(phases)
        }
        const nextEntry: RegisteredExecutor = {
            token: Symbol(normalized.id),
            id: normalized.id,
            registration: normalized
        }

        phases.forEach((phase) => {
            const current = this.slots[phase]
            if (!current) return
            throw this.createError({
                code: 'E_EXECUTION_CONFLICT',
                message: `[Atoma] execution.register: ${phase} executor 冲突: ${current.id} <-> ${nextEntry.id}`,
                retryable: false,
                details: {
                    phase,
                    existing: current.id,
                    incoming: nextEntry.id
                }
            })
        })

        phases.forEach((phase) => {
            this.slots[phase] = nextEntry
        })

        return () => {
            phases.forEach((phase) => {
                if (this.slots[phase]?.token === nextEntry.token) {
                    delete this.slots[phase]
                }
            })
        }
    }

    getConsistency = (): WriteConsistency => {
        const consistency = this.slots.write?.registration.consistency
        return consistency
            ? {
                ...ExecutionKernel.DEFAULT_CONSISTENCY,
                ...consistency
            }
            : ExecutionKernel.DEFAULT_CONSISTENCY
    }

    hasExecutor = (phase: KernelPhase): boolean => {
        return this.slots[phase] !== undefined
    }

    private resolveExecutor(phase: KernelPhase): RegisteredExecutor {
        const resolved = this.slots[phase]
        if (!resolved) {
            throw this.createError({
                code: 'E_EXECUTOR_MISSING',
                message: `[Atoma] execution: 未注册 ${phase} executor`,
                retryable: false,
                details: { phase }
            })
        }
        return resolved
    }

    private executePhase = async <Request, Output>({
        phase,
        request,
        options
    }: {
        phase: KernelPhase
        request: Request
        options?: ExecutionOptions
    }): Promise<Output> => {
        const resolved = this.resolveExecutor(phase)

        try {
            const executor = phase === 'query'
                ? resolved.registration.query as ((request: Request, options?: ExecutionOptions) => Promise<Output>) | undefined
                : resolved.registration.write as ((request: Request, options?: ExecutionOptions) => Promise<Output>) | undefined
            if (!executor) {
                throw this.createError({
                    code: phase === 'query'
                        ? 'E_EXECUTOR_QUERY_UNIMPLEMENTED'
                        : 'E_EXECUTOR_WRITE_UNIMPLEMENTED',
                    message: phase === 'query'
                        ? `[Atoma] execution.query: executor 未实现 query: ${resolved.id}`
                        : `[Atoma] execution.write: executor 未实现 write: ${resolved.id}`,
                    retryable: false,
                    details: { executor: resolved.id, phase }
                })
            }

            return await executor(request, options)
        } catch (error) {
            const normalizedError = normalizeExecutionError({
                error,
                fallbackCode: phase === 'query'
                    ? 'E_EXECUTION_QUERY_FAILED'
                    : 'E_EXECUTION_WRITE_FAILED',
                fallbackMessage: phase === 'query'
                    ? '[Atoma] execution.query failed'
                    : '[Atoma] execution.write failed',
                retryable: false,
                details: {
                    executor: resolved.id,
                    phase
                },
                createError: this.createError
            })
            throw normalizedError
        }
    }

    query = async <T extends Entity>(
        request: QueryRequest<T>,
        options?: ExecutionOptions
    ): Promise<ExecutionQueryOutput<T>> => {
        return await this.executePhase({
            phase: 'query',
            request,
            options
        })
    }

    write = async <T extends Entity>(
        request: WriteRequest<T>,
        options?: ExecutionOptions
    ): Promise<WriteOutput> => {
        return await this.executePhase({
            phase: 'write',
            request,
            options
        })
    }
}
