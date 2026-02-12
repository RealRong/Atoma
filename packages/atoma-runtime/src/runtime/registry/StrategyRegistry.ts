/**
 * StrategyRegistry: Routes persistence requests and resolves write policies by strategy.
 */
import type { Entity, WriteStrategy } from 'atoma-types/core'
import type {
    QueryInput,
    QueryOutput,
    StrategySpec,
    WriteInput,
    WriteOutput,
    Policy
} from 'atoma-types/runtime'
import type { StrategyRegistry as StrategyRegistryType } from 'atoma-types/runtime'

const DEFAULT_POLICY: Policy = {
    implicitFetch: true,
    optimistic: true
}

export class StrategyRegistry implements StrategyRegistryType {
    private readonly strategies = new Map<WriteStrategy, StrategySpec>()
    private defaultStrategy?: WriteStrategy

    register = (key: WriteStrategy, spec: StrategySpec) => {
        const k = String(key)
        if (!k) throw new Error('[Atoma] strategy.register: key 必填')
        if (this.strategies.has(k)) throw new Error(`[Atoma] strategy.register: key 已存在: ${k}`)
        this.strategies.set(k, spec)
        return () => {
            this.strategies.delete(k)
        }
    }

    setDefault = (key: WriteStrategy) => {
        const k = String(key)
        if (!k) throw new Error('[Atoma] strategy.setDefault: key 必填')
        const previous = this.defaultStrategy
        this.defaultStrategy = k
        return () => {
            if (this.defaultStrategy === k) {
                this.defaultStrategy = previous
            }
        }
    }

    resolvePolicy = (strategy?: WriteStrategy): Policy => {
        const key = String(strategy ?? this.defaultStrategy ?? '')
        if (!key) return DEFAULT_POLICY

        const spec = this.strategies.get(key)
        if (!spec?.policy) return DEFAULT_POLICY

        return {
            ...DEFAULT_POLICY,
            ...spec.policy
        }
    }

    query = async <T extends Entity>(input: QueryInput<T>): Promise<QueryOutput> => {
        const key = String(this.defaultStrategy ?? '')
        const spec = key ? this.strategies.get(key) : undefined

        if (!spec?.query) {
            return { data: [] }
        }

        return await spec.query(input)
    }

    write = async <T extends Entity>(input: WriteInput<T>): Promise<WriteOutput<T>> => {
        const key = String(input.writeStrategy ?? this.defaultStrategy ?? '')
        const spec = key ? this.strategies.get(key) : undefined

        if (!spec?.write) {
            return { status: 'confirmed' }
        }

        return await spec.write(input)
    }
}
