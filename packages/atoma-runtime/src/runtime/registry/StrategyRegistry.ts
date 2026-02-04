/**
 * StrategyRegistry: Routes persistence requests and resolves write policies by strategy.
 */
import type * as Types from 'atoma-types/core'
import type { PersistRequest, PersistResult, StrategyDescriptor, WritePolicy } from 'atoma-types/runtime'
import type { CoreRuntime, RuntimePersistence } from 'atoma-types/runtime'

const DEFAULT_WRITE_POLICY: WritePolicy = {
    implicitFetch: true,
    optimistic: true
}

export class StrategyRegistry implements RuntimePersistence {
    private readonly strategies = new Map<Types.WriteStrategy, StrategyDescriptor>()
    private readonly runtime: CoreRuntime
    private defaultStrategy?: Types.WriteStrategy

    constructor(runtime: CoreRuntime) {
        this.runtime = runtime
    }

    register = (key: Types.WriteStrategy, descriptor: StrategyDescriptor) => {
        const k = String(key)
        if (!k) throw new Error('[Atoma] strategy.register: key 必填')
        if (this.strategies.has(k)) throw new Error(`[Atoma] strategy.register: key 已存在: ${k}`)
        this.strategies.set(k, descriptor)
        return () => {
            this.strategies.delete(k)
        }
    }

    setDefaultStrategy = (key: Types.WriteStrategy) => {
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

    resolveWritePolicy = (key?: Types.WriteStrategy): WritePolicy => {
        const k = (typeof key === 'string' && key) ? key : this.defaultStrategy
        if (!k) {
            throw new Error('[Atoma] strategy.resolveWritePolicy: 未设置默认 writeStrategy')
        }
        const policy = this.strategies.get(k)?.write
        if (!policy) return DEFAULT_WRITE_POLICY
        return {
            ...DEFAULT_WRITE_POLICY,
            ...policy
        }
    }

    persist = async <T extends Types.Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        const key = this.normalizeStrategy(req.writeStrategy)
        const handler = this.strategies.get(key)?.persist
        if (!handler) {
            throw new Error(`[Atoma] strategy.persist: 未注册 writeStrategy="${String(key)}"`)
        }
        return await handler({ req, next: this.persistViaOps })
    }

    private persistViaOps = async <T extends Types.Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        const results = await this.runtime.io.executeOps({ ops: req.writeOps as any })
        return {
            status: 'confirmed',
            ...(results.length ? { results } : {})
        }
    }

    private normalizeStrategy = (key?: Types.WriteStrategy): Types.WriteStrategy => {
        const normalized = (typeof key === 'string' && key) ? key : this.defaultStrategy
        if (!normalized) {
            throw new Error('[Atoma] strategy.persist: 未设置默认 writeStrategy')
        }
        return normalized
    }
}
