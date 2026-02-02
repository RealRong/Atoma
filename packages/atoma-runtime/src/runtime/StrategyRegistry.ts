/**
 * StrategyRegistry: Routes persistence requests and resolves write policies by strategy.
 */
import type { Entity, WriteStrategy } from 'atoma-core'
import type { PersistRequest, PersistResult, StrategyDescriptor, WritePolicy, PersistAck, TranslatedWriteOp } from '../types/persistenceTypes'
import type { CoreRuntime, RuntimePersistence } from '../types/runtimeTypes'
import type { ObservabilityContext } from 'atoma-observability'
import type { OperationResult, StandardError, WriteAction, WriteItemResult, WriteResultData } from 'atoma-protocol'
import { createWritebackCollector } from './persistence/ack'

const DEFAULT_WRITE_POLICY: WritePolicy = {
    implicitFetch: true
}

export interface StrategyRegistryConfig {
    runtime: CoreRuntime
    localOnly?: boolean
}

export class StrategyRegistry implements RuntimePersistence {
    private readonly strategies = new Map<WriteStrategy, StrategyDescriptor>()
    private readonly config: StrategyRegistryConfig
    private readonly runtime: CoreRuntime

    constructor(config: StrategyRegistryConfig) {
        this.config = config
        this.runtime = config.runtime
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
        const normalized = await this.executeWriteOps<T>({
            ops: req.writeOps as any,
            context: req.context
        })
        return {
            status: 'confirmed',
            ...(normalized.ack ? { ack: normalized.ack } : {})
        }
    }

    executeWriteOps = async <T extends Entity>(args: {
        ops: Array<TranslatedWriteOp>
        context?: ObservabilityContext
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

    private normalizeStrategy = (key?: WriteStrategy): WriteStrategy => {
        const normalized = (typeof key === 'string' && key) ? key : 'direct'
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
