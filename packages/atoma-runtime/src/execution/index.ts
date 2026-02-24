import type { Entity } from 'atoma-types/core'
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
} from 'atoma-types/runtime'

type RegisteredExecutor = Readonly<{
    id: string
    query?: <T extends Entity>(request: QueryRequest<T>, options?: ExecutionOptions) => Promise<ExecutionQueryOutput<T>>
    write?: <T extends Entity>(request: WriteRequest<T>, options?: ExecutionOptions) => Promise<WriteOutput>
    consistency?: Partial<WriteConsistency>
}>

export class Execution implements ExecutionType {
    private readonly slots: Partial<Record<ExecutionPhase, RegisteredExecutor>> = {}

    private static readonly DEFAULT_CONSISTENCY: WriteConsistency = {
        base: 'fetch',
        commit: 'optimistic'
    }

    register = (registration: ExecutionRegistration): (() => void) => {
        const hasQuery = typeof registration.query === 'function'
        const hasWrite = typeof registration.write === 'function'
        const id = String(registration.id ?? '').trim()
        if (!hasQuery && !hasWrite) {
            throw new Error(`[Atoma] execution.register: 至少实现 query/write 之一: ${id || '[anonymous]'}`)
        }
        const nextEntry: RegisteredExecutor = {
            id: id || '[anonymous]',
            ...(hasQuery ? { query: registration.query } : {}),
            ...(hasWrite ? { write: registration.write } : {}),
            ...(registration.consistency ? { consistency: registration.consistency } : {})
        }

        if (hasQuery && this.slots.query) {
            throw new Error(`[Atoma] execution.register: query executor 冲突: ${this.slots.query.id} <-> ${nextEntry.id}`)
        }
        if (hasWrite && this.slots.write) {
            throw new Error(`[Atoma] execution.register: write executor 冲突: ${this.slots.write.id} <-> ${nextEntry.id}`)
        }

        if (hasQuery) this.slots.query = nextEntry
        if (hasWrite) this.slots.write = nextEntry

        return () => {
            if (hasQuery && this.slots.query === nextEntry) delete this.slots.query
            if (hasWrite && this.slots.write === nextEntry) delete this.slots.write
        }
    }

    getConsistency = (): WriteConsistency => {
        return {
            ...Execution.DEFAULT_CONSISTENCY,
            ...this.slots.write?.consistency
        }
    }

    hasExecutor = (phase: ExecutionPhase): boolean => {
        return this.slots[phase] !== undefined
    }

    query = async <T extends Entity>(
        request: QueryRequest<T>,
        options?: ExecutionOptions
    ): Promise<ExecutionQueryOutput<T>> => {
        const resolved = this.slots.query
        const executor = resolved?.query
        if (!executor) throw new Error('[Atoma] execution.query: 未注册 query executor')
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
        const resolved = this.slots.write
        const executor = resolved?.write
        if (!executor) throw new Error('[Atoma] execution.write: 未注册 write executor')
        try {
            return await executor(request, options)
        } catch (error) {
            if (error instanceof Error) throw error
            throw new Error(`[Atoma] execution.write failed: ${resolved.id}`)
        }
    }
}
