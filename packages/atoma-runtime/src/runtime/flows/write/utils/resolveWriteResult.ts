import type { Entity, StoreWritebackArgs, WriteIntent } from 'atoma-types/core'
import type {
    EntityId,
    OperationResult,
    WriteAction,
    WriteItemResult,
    WriteOp,
    WriteResultData
} from 'atoma-types/protocol'
import type { CoreRuntime, StoreHandle } from 'atoma-types/runtime'
import type { PersistPlan } from '../types'

export async function resolveWriteResultFromOperationResults<T extends Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    plan: PersistPlan<T>
    results: OperationResult[]
    primaryIntent?: WriteIntent<T>
}): Promise<{ writeback?: StoreWritebackArgs<T>; output?: T }> {
    if (!args.plan.length || !args.results.length) return {}

    const resultByOpId = new Map<string, OperationResult>()
    args.results.forEach(result => resultByOpId.set(result.opId, result))

    const upserts: T[] = []
    const versionUpdates: Array<{ key: EntityId; version: number }> = []
    let output: T | undefined

    const primary = args.primaryIntent
        ? { action: args.primaryIntent.action, entityId: args.primaryIntent.entityId }
        : undefined

    for (const entry of args.plan) {
        const operationResult = resultByOpId.get(entry.op.opId)
        if (!operationResult) throw new Error('[Atoma] missing operation result')

        if (!operationResult.ok) {
            const error = new Error(`[Atoma] op failed: ${operationResult.error.message || 'Operation failed'}`)
            ;(error as { error?: unknown }).error = operationResult.error
            throw error
        }

        const itemResults = resolveWriteItemResults(operationResult)
        const shouldApplyData = shouldApplyReturnedData(entry.op)

        for (const itemResult of itemResults) {
            const intent = entry.intents[itemResult.index]
            if (!intent) throw new Error('[Atoma] write item result index out of range')
            if (!itemResult.ok) throw toWriteItemError(entry.op.write.action, itemResult)

            if (typeof itemResult.version === 'number' && Number.isFinite(itemResult.version) && itemResult.version > 0) {
                const entityId = itemResult.entityId ?? intent.entityId
                if (entityId) {
                    versionUpdates.push({ key: entityId, version: itemResult.version })
                }
            }

            if (!shouldApplyData || !itemResult.data || typeof itemResult.data !== 'object') continue

            const normalized = await args.runtime.transform.writeback(args.handle, itemResult.data as T)
            if (!normalized) continue

            upserts.push(normalized)
            if (!output && primary && intent.action === primary.action) {
                if (!primary.entityId || intent.entityId === primary.entityId) {
                    output = normalized
                }
            }
        }
    }

    const writeback = (upserts.length || versionUpdates.length)
        ? ({
            ...(upserts.length ? { upserts } : {}),
            ...(versionUpdates.length ? { versionUpdates } : {})
        } as StoreWritebackArgs<T>)
        : undefined

    return { writeback, output }
}

function resolveWriteItemResults(operationResult: OperationResult): WriteItemResult[] {
    if (!operationResult.ok) return []
    const data = operationResult.data as WriteResultData | undefined
    if (!data || !Array.isArray(data.results) || !data.results.length) {
        throw new Error('[Atoma] missing write item results')
    }

    for (const itemResult of data.results) {
        if (typeof itemResult.index !== 'number' || !Number.isFinite(itemResult.index)) {
            throw new Error('[Atoma] write item result missing index')
        }
    }

    return data.results
}

function shouldApplyReturnedData(op: WriteOp): boolean {
    const options = op.write.options
    if (!options) return true
    if (options.returning === false) return false

    const select = options.select
    if (select && typeof select === 'object' && Object.keys(select).length > 0) {
        return false
    }

    return true
}

function toWriteItemError(action: WriteAction, result: WriteItemResult): Error {
    if (result.ok) return new Error(`[Atoma] write(${action}) failed`)
    const msg = result.error.message || 'Write failed'
    const error = new Error(`[Atoma] write(${action}) failed: ${msg}`)
    ;(error as { error?: unknown }).error = result.error
    return error
}
