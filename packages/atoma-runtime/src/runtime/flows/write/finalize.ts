import type * as Types from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { PersistAck, PersistResult } from 'atoma-types/runtime'
import type { StoreHandle } from 'atoma-types/runtime'
import type { CoreRuntime } from 'atoma-types/runtime'
import type { Store as StoreTypes } from 'atoma-core'

export async function applyPersistAck<T extends Types.Entity>(runtime: CoreRuntime, handle: StoreHandle<T>, event: StoreTypes.WriteEvent<T>, persistResult: PersistResult<T>): Promise<PersistAck<T> | undefined> {
    const ack = persistResult.ack
    if (!ack) return undefined

    const normalized = await transformAck(runtime, handle, ack)

    if (event.type === 'add' && normalized.created?.length) {
        const created = normalized.created[0] as T
        const serverId = (created as any)?.id as EntityId
        const tempId = (event.data as any)?.id as EntityId

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

export function resolveOutputFromAck<T extends Types.Entity>(event: StoreTypes.WriteEvent<T>, ack: PersistAck<T> | undefined, fallback?: T): T | undefined {
    if (!ack) return fallback

    if (event.type === 'add' && ack.created?.length) {
        return ack.created[0] as T
    }

    if ((event.type === 'update' || event.type === 'upsert') && ack.upserts?.length) {
        const id = (event.data as any)?.id as EntityId | undefined
        if (!id) return ack.upserts[0] as T
        const matched = ack.upserts.find(item => (item as any)?.id === id)
        return (matched ?? ack.upserts[0]) as T
    }

    return fallback
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