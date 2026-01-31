/**
 * Mutation Pipeline: Write Ops
 * Purpose: Translates write intents into protocol operations and executes them via the ops executor.
 * Call chain: executeMutationPersistence -> executeWriteOps -> createWritebackCollector.
 */
import type { ObservabilityContext } from 'atoma-observability'
import { Protocol, type OperationResult, type StandardError, type WriteAction, type WriteItemResult, type WriteOp, type WriteResultData } from 'atoma-protocol'
import type { CoreRuntime, Entity, PersistAck } from 'atoma-core/internal'
import type { TranslatedWriteOp, WriteIntent } from './types'
import { createWritebackCollector } from './WritebackCollector'
import type { StoreHandle } from 'atoma-core/internal'

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
}): Promise<{ ack?: PersistAck<T> }> {
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
            const processed = await args.clientRuntime.transform.outbound(args.handle, value as T)
            if (processed === undefined) {
                throw new Error('[Atoma] transform returned empty for outbound write')
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

    const results = await args.clientRuntime.io.executeOps({ ops, context: args.context })
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
    const ack = result.ack

    const created = ack?.created
        ? (await Promise.all(ack.created.map(async item => args.clientRuntime.transform.writeback(args.handle, item))))
            .filter(Boolean) as T[]
        : undefined

    const upserts = ack?.upserts
        ? (await Promise.all(ack.upserts.map(async item => args.clientRuntime.transform.writeback(args.handle, item))))
            .filter(Boolean) as T[]
        : undefined

    const ackResult = ack
        ? ({
            ...(created && created.length ? { created } : {}),
            ...(upserts && upserts.length ? { upserts } : {}),
            ...(ack.versionUpdates?.length ? { versionUpdates: ack.versionUpdates } : {})
        } as PersistAck<T>)
        : undefined

    return {
        ...(ackResult ? { ack: ackResult } : {})
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
