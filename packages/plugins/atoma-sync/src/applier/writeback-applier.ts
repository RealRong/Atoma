import type { RuntimeExtensionFacade } from 'atoma-types/client/plugins'
import type { Change, EntityId } from 'atoma-types/protocol'
import type { SyncApplier, SyncWriteAck, SyncWriteReject } from 'atoma-types/sync'

export class WritebackApplier implements SyncApplier {
    constructor(private readonly deps: {
        runtime: RuntimeExtensionFacade
    }) {}

    applyPullChanges = async (changes: Change[]) => {
        const list = Array.isArray(changes) ? changes : []
        if (!list.length) return

        const byResource = new Map<string, Change[]>()
        for (const change of list) {
            const existing = byResource.get(change.resource)
            if (existing) existing.push(change)
            else byResource.set(change.resource, [change])
        }

        for (const [resource, changesForResource] of byResource.entries()) {
            const deleteKeys: EntityId[] = []
            const upsertEntityIds: EntityId[] = []

            for (const c of changesForResource) {
                if (c.kind === 'delete') {
                    deleteKeys.push(String(c.entityId) as EntityId)
                    continue
                }
                upsertEntityIds.push(String(c.entityId) as EntityId)
            }

            const uniqueUpsertKeys = Array.from(new Set(upsertEntityIds))
            const uniqueDeleteKeys = Array.from(new Set(deleteKeys))

            const handle = this.deps.runtime.stores.resolveHandle(resource as any, 'sync.applyPullChanges')

            const upsertsRaw = uniqueUpsertKeys.length
                ? (await this.deps.runtime.strategy.query<any>({
                    storeName: String(handle.storeName),
                    handle,
                    query: {
                        filter: { op: 'in', field: 'id', values: uniqueUpsertKeys }
                    },
                })).data.filter((i: any): i is any => i !== undefined)
                : []

            const processed = await Promise.all(
                upsertsRaw.map(item => this.deps.runtime.transform.writeback(handle, item as any))
            )

            const upserts = processed.filter((item): item is any => item !== undefined)

            handle.state.applyWriteback({
                upserts,
                deletes: uniqueDeleteKeys
            } as any)
        }
    }

    applyWriteAck = async (ack: SyncWriteAck) => {
        const handle = this.deps.runtime.stores.resolveHandle(ack.resource as any, 'sync.applyWriteAck')

        const upserts: any[] = []
        const deletes: EntityId[] = []
        const versionUpdates: Array<{ key: EntityId; version: number }> = []

        const version = (ack.result as any)?.version
        if (typeof version === 'number' && Number.isFinite(version)) {
            versionUpdates.push({ key: String((ack.result as any).entityId) as EntityId, version })
        }

        const serverData = (ack.result as any)?.data
        if (serverData && typeof serverData === 'object') {
            upserts.push(serverData)
        }

        const processed = await Promise.all(
            upserts.map(item => this.deps.runtime.transform.writeback(handle, item))
        )
        const normalized = processed.filter((item): item is any => item !== undefined)

        handle.state.applyWriteback({ upserts: normalized, deletes, versionUpdates } as any)
    }

    applyWriteReject = async (
        reject: SyncWriteReject
    ) => {
        const handle = this.deps.runtime.stores.resolveHandle(reject.resource as any, 'sync.applyWriteReject')

        const upserts: any[] = []
        const deletes: EntityId[] = []

        if (reject.entry.action === 'create') {
            const tempEntityId = (reject.entry.item as any)?.entityId
            const tempKey = (typeof tempEntityId === 'string' && tempEntityId)
                ? (tempEntityId as EntityId)
                : null
            if (tempKey !== null) {
                deletes.push(tempKey)
            }
        }

        const error = (reject.result as any)?.error
        const current = (reject.result as any)?.current
        if (error?.code === 'CONFLICT' && current?.value) {
            upserts.push(current.value)
        }

        const processed = await Promise.all(
            upserts.map(item => this.deps.runtime.transform.writeback(handle, item))
        )
        const normalized = processed.filter((item): item is any => item !== undefined)

        handle.state.applyWriteback({ upserts: normalized, deletes } as any)
    }

    applyWriteResults: SyncApplier['applyWriteResults'] = async (args) => {
        const acks = Array.isArray(args?.acks) ? args!.acks : []
        const rejects = Array.isArray(args?.rejects) ? args!.rejects : []

        for (const ack of acks) {
            if (args?.signal?.aborted) return
            await this.applyWriteAck(ack)
        }
        for (const reject of rejects) {
            if (args?.signal?.aborted) return
            await this.applyWriteReject(reject)
        }
    }
}
