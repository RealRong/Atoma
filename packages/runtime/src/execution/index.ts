import type { Entity } from '@atoma-js/types/core'
import type {
    Execution as ExecutionType,
    ExecutionPhase,
    ExecutionOptions,
    ExecutionRegistration,
    QueryRequest,
    ExecutionQueryOutput,
    WriteConsistency,
    WriteRequest,
    WriteOutput
} from '@atoma-js/types/runtime'

type QueryExecutor = <T extends Entity>(
    request: QueryRequest<T>,
    options?: ExecutionOptions
) => Promise<ExecutionQueryOutput<T>>

type WriteExecutor = <T extends Entity>(
    request: WriteRequest<T>,
    options?: ExecutionOptions
) => Promise<WriteOutput>

type QuerySlot = Readonly<{
    owner: symbol
    id: string
    run: QueryExecutor
}>

type WriteSlot = Readonly<{
    owner: symbol
    id: string
    run: WriteExecutor
    consistency?: Partial<WriteConsistency>
}>

export class Execution implements ExecutionType {
    private querySlot: QuerySlot | undefined
    private writeSlot: WriteSlot | undefined

    private static readonly DEFAULT_CONSISTENCY: WriteConsistency = {
        base: 'fetch',
        commit: 'optimistic'
    }

    register = (registration: ExecutionRegistration): (() => void) => {
        const query = registration.query
        const write = registration.write
        const id = String(registration.id ?? '').trim()
        if (!query && !write) {
            throw new Error(`[Atoma] execution.register: 至少实现 query/write 之一: ${id || '[anonymous]'}`)
        }
        const resolvedId = id || '[anonymous]'

        if (query && this.querySlot) {
            throw new Error(`[Atoma] execution.register: query executor 冲突: ${this.querySlot.id} <-> ${resolvedId}`)
        }
        if (write && this.writeSlot) {
            throw new Error(`[Atoma] execution.register: write executor 冲突: ${this.writeSlot.id} <-> ${resolvedId}`)
        }

        const owner = Symbol('execution.register')
        if (query) {
            this.querySlot = {
                owner,
                id: resolvedId,
                run: query
            }
        }
        if (write) {
            this.writeSlot = {
                owner,
                id: resolvedId,
                run: write,
                ...(registration.consistency ? { consistency: registration.consistency } : {})
            }
        }

        return () => {
            if (this.querySlot?.owner === owner) {
                this.querySlot = undefined
            }
            if (this.writeSlot?.owner === owner) {
                this.writeSlot = undefined
            }
        }
    }

    getConsistency = (): WriteConsistency => {
        return {
            ...Execution.DEFAULT_CONSISTENCY,
            ...this.writeSlot?.consistency
        }
    }

    hasExecutor = (phase: ExecutionPhase): boolean => {
        return phase === 'query'
            ? this.querySlot !== undefined
            : this.writeSlot !== undefined
    }

    query = async <T extends Entity>(
        request: QueryRequest<T>,
        options?: ExecutionOptions
    ): Promise<ExecutionQueryOutput<T>> => {
        const resolved = this.querySlot
        const executor = resolved?.run
        if (!executor) {
            throw new Error('[Atoma] execution.query: 未注册 query executor')
        }
        try {
            return await executor(request, options)
        } catch (error) {
            if (error instanceof Error) throw error
            throw new Error(`[Atoma] execution.query failed: ${resolved.id}`)
        }
    }

    write = async <T extends Entity>(
        request: WriteRequest<T>,
        options?: ExecutionOptions
    ): Promise<WriteOutput> => {
        const resolved = this.writeSlot
        const executor = resolved?.run
        if (!executor) {
            throw new Error('[Atoma] execution.write: 未注册 write executor')
        }
        try {
            return await executor(request, options)
        } catch (error) {
            if (error instanceof Error) throw error
            throw new Error(`[Atoma] execution.write failed: ${resolved.id}`)
        }
    }
}
