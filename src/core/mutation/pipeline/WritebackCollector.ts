/**
 * Mutation Pipeline: Writeback Collector
 * Purpose: Collects server writeback (created entities, upserts, version updates).
 * Call chain: executeWriteOps -> createWritebackCollector -> executeMutationPersistence -> executeMutationFlow finalize.
 */
import type { EntityId, WriteItemResult } from '#protocol'
import type { Entity, PersistWriteback } from '../../types'
import type { TranslatedWriteOp } from './types'

export type WritebackCollector<T extends Entity> = Readonly<{
    collect: (entry: TranslatedWriteOp, itemRes: WriteItemResult) => void
    result: () => { created?: T[]; writeback?: PersistWriteback<T> }
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

        const returned = itemRes.data
        if (returned && typeof returned === 'object') {
            upserts.push(returned as T)
        }

        if (entry.intent === 'created') {
            if (returned && typeof returned === 'object') {
                created.push(returned as T)
            } else if (entry.requireCreatedData) {
                throw new Error('[Atoma] server-assigned create requires returning created results')
            }
        }
    }

    const result = () => {
        const writeback = (upserts.length || versionUpdates.length)
            ? ({
                ...(upserts.length ? { upserts } : {}),
                ...(versionUpdates.length ? { versionUpdates } : {})
            } as PersistWriteback<T>)
            : undefined

        return {
            ...(created.length ? { created } : {}),
            ...(writeback ? { writeback } : {})
        }
    }

    return { collect, result }
}
