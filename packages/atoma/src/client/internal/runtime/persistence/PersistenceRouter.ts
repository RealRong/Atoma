/**
 * PersistenceRouter: Routes persistence requests to appropriate handlers.
 * - Supports registering custom handlers for different write strategies.
 * - Falls back to direct execution (executeWriteOps) when no handler matches.
 */
import type {
    CoreRuntime,
    Entity,
    PersistHandler,
    PersistRequest,
    PersistResult,
    RuntimePersistence,
    WriteStrategy
} from '#core'
import type { StoreHandle } from '#core/store/internals/handleTypes'
import { executeWriteOps } from '#core/mutation/pipeline/WriteOps'

export interface PersistenceRouterConfig {
    getRuntimeAndHandle: <T extends Entity>(req: PersistRequest<T>) => {
        runtime: CoreRuntime
        handle: StoreHandle<T>
    }
    localOnly?: boolean
}

export class PersistenceRouter implements RuntimePersistence {
    private handlers = new Map<WriteStrategy, PersistHandler>()
    private readonly config: PersistenceRouterConfig

    constructor(config: PersistenceRouterConfig) {
        this.config = config
    }

    register = (key: WriteStrategy, handler: PersistHandler) => {
        const k = String(key)
        if (!k) throw new Error('[Atoma] persistence.register: key 必填')
        if (this.handlers.has(k)) throw new Error(`[Atoma] persistence.register: key 已存在: ${k}`)
        this.handlers.set(k, handler)
        return () => {
            this.handlers.delete(k)
        }
    }

    persist = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        const key = req.writeStrategy
        if (!key || key === 'direct') {
            return await this.directPersist(req)
        }
        const handler = this.handlers.get(key)
        if (!handler) {
            throw new Error(`[Atoma] persistence: 未注册 writeStrategy="${String(key)}"`)
        }
        return await handler({ req, next: this.directPersist })
    }

    private directPersist = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        if (this.config.localOnly) {
            return { status: 'confirmed' }
        }
        const { runtime, handle } = this.config.getRuntimeAndHandle(req)
        const normalized = await executeWriteOps<T>({
            clientRuntime: runtime,
            handle: handle,
            ops: req.writeOps as any,
            context: req.context
        })
        return {
            status: 'confirmed',
            ...(normalized.ack ? { ack: normalized.ack } : {})
        }
    }
}
