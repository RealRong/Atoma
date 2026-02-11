/**
 * StrategyRegistry: Routes persistence requests and resolves write policies by strategy.
 */
import type { Entity, WriteStrategy } from 'atoma-types/core'
import type { PersistRequest, PersistResult, StrategyDescriptor, WritePolicy } from 'atoma-types/runtime'
import type { StrategyRegistry as StrategyRegistryType } from 'atoma-types/runtime'

const DEFAULT_WRITE_POLICY: WritePolicy = {
    implicitFetch: true,
    optimistic: true
}

export class StrategyRegistry implements StrategyRegistryType {
    private readonly strategies = new Map<WriteStrategy, StrategyDescriptor>()
    private defaultStrategy?: WriteStrategy

    register = (key: WriteStrategy, descriptor: StrategyDescriptor) => {
        const k = String(key)
        if (!k) throw new Error('[Atoma] strategy.register: key 必填')
        if (this.strategies.has(k)) throw new Error(`[Atoma] strategy.register: key 已存在: ${k}`)
        this.strategies.set(k, descriptor)
        return () => {
            this.strategies.delete(k)
        }
    }

    setDefaultStrategy = (key: WriteStrategy) => {
        const k = String(key)
        if (!k) throw new Error('[Atoma] strategy.setDefaultStrategy: key 必填')
        const previous = this.defaultStrategy
        this.defaultStrategy = k
        return () => {
            if (this.defaultStrategy === k) {
                this.defaultStrategy = previous
            }
        }
    }

    resolveWritePolicy = (strategy?: WriteStrategy): WritePolicy => {
        const key = String(strategy ?? this.defaultStrategy ?? '')
        if (!key) return DEFAULT_WRITE_POLICY

        const descriptor = this.strategies.get(key)
        if (!descriptor?.write) return DEFAULT_WRITE_POLICY

        return {
            ...DEFAULT_WRITE_POLICY,
            ...descriptor.write
        }
    }

    persist = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        const key = String(req.writeStrategy ?? this.defaultStrategy ?? '')
        const descriptor = key ? this.strategies.get(key) : undefined

        if (!descriptor?.persist) {
            return { status: 'confirmed' }
        }

        return await descriptor.persist(req)
    }
}
