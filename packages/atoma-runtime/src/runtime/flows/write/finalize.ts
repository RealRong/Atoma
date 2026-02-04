import type * as Types from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { PersistAck, PersistResult, StoreHandle, CoreRuntime } from 'atoma-types/runtime'

export async function applyPersistAck<T extends Types.Entity>(runtime: CoreRuntime, handle: StoreHandle<T>, intent: Types.WriteIntent<T> | undefined, persistResult: PersistResult<T>): Promise<PersistAck<T> | undefined> {
    const ack = persistResult.ack
    if (!ack) return undefined

    const normalized = await transformAck(runtime, handle, ack)

    if (intent?.action === 'create' && normalized.created?.length) {
        const created = normalized.created[0] as T
        const serverId = created?.id as EntityId
        const tempId = intent.entityId as EntityId

        const deletes: EntityId[] = []
        if (tempId && serverId && tempId !== serverId) {
            deletes.push(tempId)
        }
        handle.stateWriter.applyWriteback({
            deletes,
            upserts: [created],
            versionUpdates: normalized.versionUpdates
        })
        return normalized
    }

    handle.stateWriter.applyWriteback({
        upserts: normalized.upserts,
        deletes: normalized.deletes,
        versionUpdates: normalized.versionUpdates
    })

    return normalized
}

async function transformAck<T extends Types.Entity>(runtime: CoreRuntime, handle: StoreHandle<T>, ack: PersistAck<T>): Promise<PersistAck<T>> {
    const created = ack.created
        ? (await Promise.all(ack.created.map(async item => runtime.transform.writeback(handle, item))))
            .filter(Boolean) as T[]
        : undefined

    const upserts = ack.upserts
        ? (await Promise.all(ack.upserts.map(async item => runtime.transform.writeback(handle, item))))
            .filter(Boolean) as T[]
        : undefined

    return {
        ...(created && created.length ? { created } : {}),
        ...(upserts && upserts.length ? { upserts } : {}),
        ...(ack.deletes?.length ? { deletes: ack.deletes } : {}),
        ...(ack.versionUpdates?.length ? { versionUpdates: ack.versionUpdates } : {})
    }
}
