/**
 * Mutation Pipeline: Write Ops
 * Purpose: Translates write intents into protocol operations and executes them via the ops executor.
 * Call chain: executeMutationPersistence -> executeWriteOps -> createWritebackCollector.
 */
import type { ObservabilityContext } from '#observability'
import { Protocol, type OperationResult, type StandardError, type WriteAction, type WriteItemResult, type WriteOp, type WriteResultData } from '#protocol'
import type { CoreRuntime, Entity, PersistWriteback } from '../../types'
import { executeOps } from '../../ops/opsExecutor'
import type { TranslatedWriteOp, WriteIntent } from './types'
import { createWritebackCollector } from './WritebackCollector'
import type { StoreHandle } from '../../store/internals/handleTypes'

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
    clientRuntime: CoreRuntime
    handle: StoreHandle<T>
    ops: Array<TranslatedWriteOp>
    context?: ObservabilityContext
}): Promise<{ created?: T[]; writeback?: PersistWriteback<T> }> {
    if (!args.ops.length) return {}

    const processedOps: TranslatedWriteOp[] = []
    for (const entry of args.ops) {
        const op = entry.op as WriteOp
        if (op.kind !== 'write') {
            processedOps.push(entry)
            continue
        }

        const write = (op as any).write
        const items = Array.isArray(write?.items) ? (write.items as any[]) : []
        if (!items.length) {
            processedOps.push(entry)
            continue
        }

        const nextItems = []
        for (const item of items) {
            if (!item || typeof item !== 'object' || !('value' in item)) {
                nextItems.push(item)
                continue
            }
            const value = (item as any).value
            if (value === undefined) {
                nextItems.push(item)
                continue
            }
            const processed = await args.clientRuntime.dataProcessor.outbound(args.handle, value as T)
            if (processed === undefined) {
                throw new Error('[Atoma] dataProcessor returned empty for outbound write')
            }
            nextItems.push({ ...(item as any), value: processed })
        }

        const nextOp = {
            ...(op as any),
            write: {
                ...(write as any),
                items: nextItems
            }
        } as WriteOp

        processedOps.push({ ...entry, op: nextOp })
    }

    const ops = processedOps.map(o => o.op)

    const results = await executeOps(args.clientRuntime, ops, args.context)
    const resultByOpId = new Map<string, OperationResult>()
    results.forEach(r => resultByOpId.set(r.opId, r))

    const writeback = createWritebackCollector<T>()

    for (const entry of processedOps) {
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

    const result = writeback.result()

    const created = result.created
        ? (await Promise.all(result.created.map(async item => args.clientRuntime.dataProcessor.writeback(args.handle, item))))
            .filter((item): item is T => item !== undefined)
        : undefined

    const writebackResult = result.writeback
        ? {
            ...result.writeback,
            ...(result.writeback.upserts
                ? {
                    upserts: (await Promise.all(result.writeback.upserts.map(async item => args.clientRuntime.dataProcessor.writeback(args.handle, item))))
                        .filter((item): item is T => item !== undefined)
                }
                : {})
        }
        : undefined

    return {
        ...(created && created.length ? { created } : {}),
        ...(writebackResult ? { writeback: writebackResult } : {})
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
