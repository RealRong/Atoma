import type { Entity } from 'atoma-types/core'
import type {
    ExecutionKernel as ExecutionKernelType,
    ExecutionPhase,
    ExecutionOptions,
    ExecutionRegistration,
    QueryRequest,
    ExecutionQueryOutput,
    WriteConsistency,
    WriteRequest,
    WriteOutput
} from 'atoma-types/runtime'

type RegisteredExecutor = Readonly<{
    token: symbol
    id: string
    registration: ExecutionRegistration
}>

export class ExecutionKernel implements ExecutionKernelType {
    private readonly slots: Partial<Record<ExecutionPhase, RegisteredExecutor>> = {}
    private anonymousIdCounter = 0

    private static readonly DEFAULT_CONSISTENCY: WriteConsistency = {
        base: 'fetch',
        commit: 'optimistic'
    }

    private createAnonymousId = (phases: ReadonlyArray<ExecutionPhase>): string => {
        this.anonymousIdCounter += 1
        return `anonymous-${phases.join('-')}-${this.anonymousIdCounter}`
    }

    register = (registration: ExecutionRegistration): (() => void) => {
        const phases: ExecutionPhase[] = []
        if (typeof registration.query === 'function') phases.push('query')
        if (typeof registration.write === 'function') phases.push('write')
        const id = String(registration.id ?? '').trim()
        if (!phases.length) {
            throw new Error(`[Atoma] execution.register: 至少实现 query/write 之一: ${id || '[anonymous]'}`)
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
            throw new Error(`[Atoma] execution.register: ${phase} executor 冲突: ${current.id} <-> ${nextEntry.id}`)
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
        return {
            ...ExecutionKernel.DEFAULT_CONSISTENCY,
            ...this.slots.write?.registration.consistency
        }
    }

    hasExecutor = (phase: ExecutionPhase): boolean => {
        return this.slots[phase] !== undefined
    }

    private resolveExecutor(phase: ExecutionPhase): RegisteredExecutor {
        const resolved = this.slots[phase]
        if (!resolved) {
            throw new Error(`[Atoma] execution: 未注册 ${phase} executor`)
        }
        return resolved
    }

    private executePhase = async <Request, Output>({
        phase,
        executorId,
        executor,
        request,
        options
    }: {
        phase: ExecutionPhase
        executorId: string
        executor: (request: Request, options?: ExecutionOptions) => Promise<Output>
        request: Request
        options?: ExecutionOptions
    }): Promise<Output> => {
        try {
            return await executor(request, options)
        } catch (error) {
            if (error instanceof Error) throw error
            throw new Error(
                phase === 'query'
                    ? `[Atoma] execution.query failed: ${executorId}`
                    : `[Atoma] execution.write failed: ${executorId}`
            )
        }
    }

    query = async <T extends Entity>(
        request: QueryRequest<T>,
        options?: ExecutionOptions
    ): Promise<ExecutionQueryOutput<T>> => {
        const resolved = this.resolveExecutor('query')
        const executor = resolved.registration.query
        if (!executor) {
            throw new Error(`[Atoma] execution.query: executor 未实现 query: ${resolved.id}`)
        }
        return await this.executePhase({
            phase: 'query',
            executorId: resolved.id,
            executor,
            request,
            options
        })
    }

    write = async <T extends Entity>(
        request: WriteRequest<T>,
        options?: ExecutionOptions
    ): Promise<WriteOutput> => {
        const resolved = this.resolveExecutor('write')
        const executor = resolved.registration.write
        if (!executor) {
            throw new Error(`[Atoma] execution.write: executor 未实现 write: ${resolved.id}`)
        }
        return await this.executePhase({
            phase: 'write',
            executorId: resolved.id,
            executor,
            request,
            options
        })
    }
}
