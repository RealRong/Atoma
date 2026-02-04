import type { EntityId, WriteItemResult } from 'atoma-types/protocol'
import type * as Types from 'atoma-types/core'
import type { PersistAck, TranslatedWriteOp } from 'atoma-types/runtime'

export class WritebackCollector<T extends Types.Entity> {
    private readonly created: T[] = []
    private readonly upserts: T[] = []
    private readonly versionUpdates: Array<{ key: EntityId; version: number }> = []

    collect = (entry: TranslatedWriteOp, itemRes: WriteItemResult) => {
        if (!itemRes.ok) return
        const version = itemRes.version
        if (typeof version === 'number' && Number.isFinite(version) && version > 0) {
            const entityId = itemRes.entityId ?? entry.entityId
            if (entityId) this.versionUpdates.push({ key: entityId, version })
        }

        const shouldApplyData = shouldUseWritebackData(entry)
        const returned = itemRes.data
        if (shouldApplyData && returned && typeof returned === 'object') {
            this.upserts.push(returned as T)
        }

        if (entry.intent === 'created') {
            if (shouldApplyData && returned && typeof returned === 'object') {
                this.created.push(returned as T)
            } else if (entry.requireCreatedData) {
                throw new Error('[Atoma] server-assigned create requires returning created results')
            }
        }
    }

    result = () => {
        const ack = (this.created.length || this.upserts.length || this.versionUpdates.length)
            ? ({
                ...(this.created.length ? { created: this.created } : {}),
                ...(this.upserts.length ? { upserts: this.upserts } : {}),
                ...(this.versionUpdates.length ? { versionUpdates: this.versionUpdates } : {})
            } as PersistAck<T>)
            : undefined

        return {
            ...(ack ? { ack } : {})
        }
    }
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
