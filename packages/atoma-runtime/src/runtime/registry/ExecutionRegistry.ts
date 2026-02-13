import type { Entity, WriteStrategy } from 'atoma-types/core'
import type {
    ExecutionEvent,
    ExecutionRegistry as ExecutionRegistryType,
    ExecutionSpec,
    Policy,
    QueryInput,
    QueryOutput,
    WriteInput,
    WriteOutput
} from 'atoma-types/runtime'

/**
 * ExecutionRegistry: runtime 的执行端口注册表。
 * 用于在 runtime 语义流中替代直接策略执行，提供可失败感知的执行入口。
 */
export class ExecutionRegistry implements ExecutionRegistryType {
    private readonly executions = new Map<WriteStrategy, ExecutionSpec>()
    private readonly listeners = new Set<(event: ExecutionEvent) => void>()
    private defaultExecution?: WriteStrategy

    private static readonly DEFAULT_POLICY: Policy = {
        implicitFetch: true,
        optimistic: true
    }

    register = (key: WriteStrategy, spec: ExecutionSpec) => {
        const k = String(key)
        if (!k) throw new Error('[Atoma] execution.register: key 必填')
        if (this.executions.has(k)) throw new Error(`[Atoma] execution.register: key 已存在: ${k}`)

        this.executions.set(k, spec)
        return () => {
            this.executions.delete(k)
            if (this.defaultExecution === k) {
                this.defaultExecution = undefined
            }
        }
    }

    setDefault = (key: WriteStrategy) => {
        const k = String(key)
        if (!k) throw new Error('[Atoma] execution.setDefault: key 必填')
        if (!this.executions.has(k)) {
            throw new Error(`[Atoma] execution.setDefault: key 未注册: ${k}`)
        }

        const previous = this.defaultExecution
        this.defaultExecution = k
        return () => {
            if (this.defaultExecution === k) {
                this.defaultExecution = previous
            }
        }
    }

    resolvePolicy = (key?: WriteStrategy): Policy => {
        const k = String(key ?? this.defaultExecution ?? '')
        if (!k) return ExecutionRegistry.DEFAULT_POLICY

        const spec = this.executions.get(k)
        if (!spec?.policy) return ExecutionRegistry.DEFAULT_POLICY

        return {
            ...ExecutionRegistry.DEFAULT_POLICY,
            ...spec.policy
        }
    }

    subscribe = (listener: (event: ExecutionEvent) => void) => {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    private emitEvent = (event: ExecutionEvent): void => {
        for (const listener of this.listeners) {
            try {
                listener(event)
            } catch {
                // ignore
            }
        }
    }

    private resolveExecution = (key?: WriteStrategy): { key: string; spec: ExecutionSpec } => {
        const resolved = String(key ?? this.defaultExecution ?? '')
        if (!resolved) {
            throw new Error('[Atoma] execution: 未配置默认执行器，请先 register + setDefault')
        }

        const spec = this.executions.get(resolved)
        if (!spec) {
            throw new Error(`[Atoma] execution: 未找到执行器: ${resolved}`)
        }

        return { key: resolved, spec }
    }

    query = async <T extends Entity>(input: QueryInput<T>): Promise<QueryOutput> => {
        const { key, spec } = this.resolveExecution()
        if (!spec.query) {
            throw new Error(`[Atoma] execution.query: 执行器未实现 query: ${key}`)
        }
        try {
            const output = await spec.query(input)
            this.emitEvent({
                type: 'query.succeeded',
                strategy: key,
                input,
                output
            })
            return output
        } catch (error) {
            this.emitEvent({
                type: 'query.failed',
                strategy: key,
                input,
                error
            })
            throw error
        }
    }

    write = async <T extends Entity>(input: WriteInput<T>): Promise<WriteOutput<T>> => {
        const { key, spec } = this.resolveExecution(input.writeStrategy)
        if (!spec.write) {
            throw new Error(`[Atoma] execution.write: 执行器未实现 write: ${key}`)
        }
        try {
            const output = await spec.write(input)
            this.emitEvent({
                type: 'write.succeeded',
                strategy: key,
                input,
                output
            })
            return output
        } catch (error) {
            this.emitEvent({
                type: 'write.failed',
                strategy: key,
                input,
                error
            })
            throw error
        }
    }
}
