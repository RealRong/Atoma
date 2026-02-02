import type { ObservabilityContext } from 'atoma-observability'
import type { OperationResult, StandardError, WriteAction, WriteItemResult, WriteResultData } from 'atoma-protocol'
import type { Entity } from 'atoma-core'
import type { PersistAck, TranslatedWriteOp } from '../../types/persistenceTypes'
import type { CoreRuntime, StoreHandle } from '../../types/runtimeTypes'
import { createWritebackCollector } from './ackCollector'

export async function executeWriteOps<T extends Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    ops: Array<TranslatedWriteOp>
    context?: ObservabilityContext
}): Promise<{ ack?: PersistAck<T> }> {
    if (!args.ops.length) return {}

    const ops = args.ops.map(o => o.op)
    const results = await args.runtime.io.executeOps({ ops, context: args.context })
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
