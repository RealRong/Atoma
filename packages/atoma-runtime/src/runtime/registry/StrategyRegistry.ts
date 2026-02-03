/**
 * StrategyRegistry: Routes persistence requests and resolves write policies by strategy.
 */
import type * as Types from 'atoma-types/core'
import type { PersistRequest, PersistResult, StrategyDescriptor, WritePolicy, PersistAck, TranslatedWriteOp } from 'atoma-types/runtime'
import type { CoreRuntime, RuntimePersistence } from 'atoma-types/runtime'
import type { OperationResult, StandardError, WriteAction, WriteItemResult, WriteResultData } from 'atoma-types/protocol'
import { createWritebackCollector } from '../persistence'

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
        const normalized = await this.executeWriteOps<T>({
            ops: req.writeOps as any,
            context: req.context
        })
        return {
            status: 'confirmed',
            ...(normalized.ack ? { ack: normalized.ack } : {})
        }
    }

    executeWriteOps = async <T extends Types.Entity>(args: {
        ops: Array<TranslatedWriteOp>
        context?: Types.ObservabilityContext
    }): Promise<{ ack?: PersistAck<T> }> => {
        if (!args.ops.length) return {}

        const ops = args.ops.map(o => o.op)
        const results = await this.runtime.io.executeOps({ ops, context: args.context })
        const resultByOpId = new Map<string, OperationResult>()
        results.forEach(r => resultByOpId.set(r.opId, r))

        const writeback = createWritebackCollector<T>()

        for (const entry of args.ops) {
            const result = findOpResult(resultByOpId, entry.op.opId)
            if (!result.ok) {
                const err = new Error(`[Atoma] op failed: ${result.error.message || 'Operation failed'}`)
                ;(err as { error?: unknown }).error = result.error
                throw err
            }

            const data = result.data as WriteResultData
            const itemRes = data.results?.[0]
            if (!itemRes) throw new Error('[Atoma] missing write item result')
            if (!itemRes.ok) throw toWriteItemError(entry.action, itemRes)

            writeback.collect(entry, itemRes)
        }

        return writeback.result()
    }

    private normalizeStrategy = (key?: Types.WriteStrategy): Types.WriteStrategy => {
        const normalized = (typeof key === 'string' && key) ? key : this.defaultStrategy
        if (!normalized) {
            throw new Error('[Atoma] strategy.persist: 未设置默认 writeStrategy')
        }
        return normalized
    }
}

function toWriteItemError(action: WriteAction, result: WriteItemResult): Error {
    if (result.ok) return new Error(`[Atoma] write(${action}) failed`)
    const msg = result.error.message || 'Write failed'
    const err = new Error(`[Atoma] write(${action}) failed: ${msg}`)
    ;(err as { error?: unknown }).error = result.error
    return err
}

function findOpResult(results: Map<string, OperationResult>, opId: string): OperationResult {
    const found = results.get(opId)
    if (found) return found
    return {
        opId,
        ok: false,
        error: {
            code: 'INTERNAL',
            message: 'Missing operation result',
            kind: 'internal'
        } as StandardError
    }
}
