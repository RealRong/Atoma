/**
 * StrategyRegistry: Routes persistence requests and resolves write policies by strategy.
 */
import type { Entity, WriteStrategy } from 'atoma-core'
import type { PersistRequest, PersistResult, StrategyDescriptor, WritePolicy } from '../types/persistenceTypes'
import type { CoreRuntime, RuntimePersistence, StoreHandle } from '../types/runtimeTypes'
import { executeWriteOps } from './write/WriteOps'

const DEFAULT_WRITE_POLICY: WritePolicy = {
    implicitFetch: true
}

export interface StrategyRegistryConfig {
    getRuntimeAndHandle: <T extends Entity>(req: PersistRequest<T>) => {
        runtime: CoreRuntime
        handle: StoreHandle<T>
    }
    localOnly?: boolean
}

export class StrategyRegistry implements RuntimePersistence {
    private readonly strategies = new Map<WriteStrategy, StrategyDescriptor>()
    private readonly config: StrategyRegistryConfig

    constructor(config: StrategyRegistryConfig) {
        this.config = config
    }

    register = (key: WriteStrategy, descriptor: StrategyDescriptor) => {
        const k = String(key)
        if (!k) throw new Error('[Atoma] strategy.register: key 必填')
        if (this.strategies.has(k)) throw new Error(`[Atoma] strategy.register: key 已存在: ${k}`)
        this.strategies.set(k, descriptor)
        return () => {
            this.strategies.delete(k)
        }
    }

    resolveWritePolicy = (key?: WriteStrategy): WritePolicy => {
        const k = this.normalizeStrategy(key)
        const policy = this.strategies.get(k)?.write
        if (!policy) return DEFAULT_WRITE_POLICY
        return {
            ...DEFAULT_WRITE_POLICY,
            ...policy
        }
    }

    persist = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        const key = this.normalizeStrategy(req.writeStrategy)
        const handler = this.strategies.get(key)?.persist
        if (handler) {
            return await handler({ req, next: this.directPersist })
        }
        if (key === 'direct') {
            return await this.directPersist(req)
        }
        throw new Error(`[Atoma] strategy.persist: 未注册 writeStrategy="${String(key)}"`)
    }

    private directPersist = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        if (this.config.localOnly) {
            return { status: 'confirmed' }
        }
        const { runtime, handle } = this.config.getRuntimeAndHandle(req)
        const normalized = await executeWriteOps<T>({
            runtime,
            handle: handle,
            ops: req.writeOps as any,
            context: req.context
        })
        return {
            status: 'confirmed',
            ...(normalized.ack ? { ack: normalized.ack } : {})
        }
    }

    private normalizeStrategy = (key?: WriteStrategy): WriteStrategy => {
        const normalized = (typeof key === 'string' && key) ? key : 'direct'
        return normalized
    }
}
