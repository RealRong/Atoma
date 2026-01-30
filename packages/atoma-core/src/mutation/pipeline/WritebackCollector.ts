/**
 * Mutation Pipeline: Writeback Collector
 * Purpose: Collects server ack (created entities, upserts, version updates).
 * Call chain: executeWriteOps -> createWritebackCollector -> executeMutationPersistence -> executeMutationFlow finalize.
 */
import type { EntityId, WriteItemResult } from 'atoma-protocol'
import type { Entity, PersistAck } from '../../types'
import type { TranslatedWriteOp } from './types'

export type WritebackCollector<T extends Entity> = Readonly<{
    collect: (entry: TranslatedWriteOp, itemRes: WriteItemResult) => void
    result: () => { ack?: PersistAck<T> }
}>

export function createWritebackCollector<T extends Entity>(): WritebackCollector<T> {
    const created: T[] = []
    const upserts: T[] = []
    const versionUpdates: Array<{ key: EntityId; version: number }> = []

    const collect = (entry: TranslatedWriteOp, itemRes: WriteItemResult) => {
        if (!itemRes.ok) return
        const version = itemRes.version
        if (typeof version === 'number' && Number.isFinite(version) && version > 0) {
            const entityId = itemRes.entityId ?? entry.entityId
            if (entityId) versionUpdates.push({ key: entityId, version })
        }

        const shouldApplyData = shouldUseWritebackData(entry)
        const returned = itemRes.data
        if (shouldApplyData && returned && typeof returned === 'object') {
            upserts.push(returned as T)
        }

        if (entry.intent === 'created') {
            if (shouldApplyData && returned && typeof returned === 'object') {
                created.push(returned as T)
            } else if (entry.requireCreatedData) {
                throw new Error('[Atoma] server-assigned create requires returning created results')
            }
        }
    }

    const result = () => {
        const ack = (created.length || upserts.length || versionUpdates.length)
            ? ({
                ...(created.length ? { created } : {}),
                ...(upserts.length ? { upserts } : {}),
                ...(versionUpdates.length ? { versionUpdates } : {})
            } as PersistAck<T>)
            : undefined

        return {
            ...(ack ? { ack } : {})
        }
    }

    return { collect, result }
}

function shouldUseWritebackData(entry: TranslatedWriteOp): boolean {
    const op: any = entry.op
    if (!op || op.kind !== 'write') return false
    const options = (op.write && typeof op.write === 'object') ? (op.write as any).options : undefined
    if (!options || typeof options !== 'object') return true
    if ((options as any).returning === false) return false
    const select = (options as any).select
    if (select && typeof select === 'object' && Object.keys(select as any).length) return false
    return true
}
