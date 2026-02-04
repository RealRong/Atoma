import type * as Types from 'atoma-types/core'
import type { EntityId, OperationResult, WriteAction, WriteItemResult, WriteOp } from 'atoma-types/protocol'
import type { StoreHandle, CoreRuntime } from 'atoma-types/runtime'

type WritePlan<T extends Types.Entity> = ReadonlyArray<{
    op: WriteOp
    intents: Array<Types.WriteIntent<T>>
}>

export async function buildWritebackFromResults<T extends Types.Entity>(args: {
    runtime: CoreRuntime
    handle: StoreHandle<T>
    plan: WritePlan<T>
    results: OperationResult[]
    primaryIntent?: Types.WriteIntent<T>
}): Promise<{ writeback?: Types.StoreWritebackArgs<T>; output?: T }> {
    if (!args.plan.length || !args.results.length) return {}

    const resultByOpId = new Map<string, OperationResult>()
    args.results.forEach(r => resultByOpId.set(r.opId, r))

    const upserts: T[] = []
    const versionUpdates: Array<{ key: EntityId; version: number }> = []
    let output: T | undefined

    const primary = args.primaryIntent
        ? { action: args.primaryIntent.action, entityId: args.primaryIntent.entityId as EntityId | undefined }
        : undefined

    for (const entry of args.plan) {
        const result = resultByOpId.get(entry.op.opId)
        if (!result) throw new Error('[Atoma] missing operation result')
        if (!result.ok) {
            const err = new Error(`[Atoma] op failed: ${result.error.message || 'Operation failed'}`)
            ;(err as { error?: unknown }).error = result.error
            throw err
        }

        const data = (result as any).data
        const itemResults = Array.isArray((data as any)?.results) ? (data as any).results as WriteItemResult[] : []
        if (!itemResults.length) throw new Error('[Atoma] missing write item results')

        const shouldApplyData = shouldUseWritebackData(entry.op)

        for (const itemRes of itemResults) {
            const index = (itemRes as any)?.index
            if (typeof index !== 'number' || !Number.isFinite(index)) {
                throw new Error('[Atoma] write item result missing index')
            }

            const intent = entry.intents[index]
            if (!intent) throw new Error('[Atoma] write item result index out of range')
            if (!itemRes.ok) throw toWriteItemError(entry.op.write.action, itemRes)

            const version = itemRes.version
            if (typeof version === 'number' && Number.isFinite(version) && version > 0) {
                const entityId = itemRes.entityId ?? (intent.entityId as EntityId | undefined)
                if (entityId) versionUpdates.push({ key: entityId, version })
            }

            if (!shouldApplyData) continue
            const returned = itemRes.data
            if (!returned || typeof returned !== 'object') continue

            const normalized = await args.runtime.transform.writeback(args.handle, returned as T)
            if (!normalized) continue

            upserts.push(normalized)
            if (!output && primary && intent.action === primary.action) {
                if (primary.entityId === undefined || intent.entityId === primary.entityId) {
                    output = normalized as T
                }
            }
        }
    }

    const writeback = (upserts.length || versionUpdates.length)
        ? ({
            ...(upserts.length ? { upserts } : {}),
            ...(versionUpdates.length ? { versionUpdates } : {})
        } as Types.StoreWritebackArgs<T>)
        : undefined

    return { writeback, output }
}

function shouldUseWritebackData(op: WriteOp): boolean {
    const options = (op.write && typeof op.write === 'object') ? (op.write as any).options : undefined
    if (!options || typeof options !== 'object') return true
    if ((options as any).returning === false) return false
    const select = (options as any).select
    if (select && typeof select === 'object' && Object.keys(select as any).length) return false
    return true
}

function toWriteItemError(action: WriteAction, result: WriteItemResult): Error {
    if (result.ok) return new Error(`[Atoma] write(${action}) failed`)
    const msg = result.error.message || 'Write failed'
    const err = new Error(`[Atoma] write(${action}) failed: ${msg}`)
    ;(err as { error?: unknown }).error = result.error
    return err
}
