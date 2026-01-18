/**
 * Mutation Pipeline: Write Ops
 * Purpose: Translates write intents into protocol operations and executes them via the ops executor.
 * Call chain: executeMutationPersistence -> executeWriteOps -> createWritebackCollector.
 */
import type { ObservabilityContext } from '#observability'
import { Protocol, type OperationResult, type StandardError, type WriteAction, type WriteItemResult, type WriteOp, type WriteResultData } from '#protocol'
import type { Entity, PersistWriteback, StoreHandle } from '../../types'
import { executeOps } from '../../ops/opsExecutor'
import type { TranslatedWriteOp, WriteIntent } from './types'
import { createWritebackCollector } from './WritebackCollector'

export function translateWriteIntentsToOps<T extends Entity>(args: {
    handle: StoreHandle<T>
    intents: Array<WriteIntent>
}): TranslatedWriteOp[] {
    const out: TranslatedWriteOp[] = []

    for (const intent of args.intents) {
        const op: WriteOp = Protocol.ops.build.buildWriteOp({
            opId: args.handle.nextOpId('w'),
            write: {
                resource: args.handle.storeName,
                action: intent.action,
                items: [intent.item],
                ...(intent.options ? { options: intent.options } : {})
            }
        })
        out.push({
            op,
            action: intent.action,
            ...(intent.entityId ? { entityId: intent.entityId } : {}),
            ...(intent.intent ? { intent: intent.intent } : {}),
            ...(typeof intent.requireCreatedData === 'boolean' ? { requireCreatedData: intent.requireCreatedData } : {})
        })
    }

    return out
}

export async function executeWriteOps<T extends Entity>(args: {
    handle: StoreHandle<T>
    ops: Array<TranslatedWriteOp>
    context?: ObservabilityContext
}): Promise<{ created?: T[]; writeback?: PersistWriteback<T> }> {
    const ops = args.ops.map(o => o.op)
    if (!ops.length) return {}

    const results = await executeOps(args.handle, ops, args.context)
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
