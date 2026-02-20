import type { PluginRuntime } from 'atoma-types/client/plugins'
import type { Change, EntityId } from 'atoma-types/protocol'
import type { SyncApplier, SyncWriteAck, SyncWriteReject } from 'atoma-types/sync'

export class WritebackApplier implements SyncApplier {
    constructor(private readonly deps: {
        runtime: PluginRuntime
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
            const upsertIds: EntityId[] = []

            for (const c of changesForResource) {
                if (c.kind === 'delete') {
                    deleteKeys.push(String(c.id) as EntityId)
                    continue
                }
                upsertIds.push(String(c.id) as EntityId)
            }

            const uniqueUpsertKeys = Array.from(new Set(upsertIds))
            const uniqueDeleteKeys = Array.from(new Set(deleteKeys))

            const upsertsRaw = uniqueUpsertKeys.length
                ? this.deps.runtime.stores.query<any>(
                    resource as any,
                    {
                        filter: { op: 'in', field: 'id', values: uniqueUpsertKeys }
                    }
                ).data.filter((i: any): i is any => i !== undefined)
                : []

            await this.deps.runtime.stores.writeback(resource as any, {
                upserts: upsertsRaw,
                deletes: uniqueDeleteKeys
            } as any)
        }
    }

    applyWriteAck = async (ack: SyncWriteAck) => {
        const upserts: any[] = []
        const deletes: EntityId[] = []
        const versionUpdates: Array<{ id: EntityId; version: number }> = []

        const version = (ack.result as any)?.version
        if (typeof version === 'number' && Number.isFinite(version)) {
            versionUpdates.push({ id: String((ack.result as any).id) as EntityId, version })
        }

        const serverData = (ack.result as any)?.data
        if (serverData && typeof serverData === 'object') {
            upserts.push(serverData)
        }

        await this.deps.runtime.stores.writeback(ack.resource as any, {
            upserts,
            deletes,
            versionUpdates
        } as any)
    }

    applyWriteReject = async (
        reject: SyncWriteReject
    ) => {
        const upserts: any[] = []
        const deletes: EntityId[] = []

        if (reject.entry.action === 'create') {
            const tempId = (reject.entry.item as any)?.id
            const tempKey = (typeof tempId === 'string' && tempId)
                ? (tempId as EntityId)
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

        await this.deps.runtime.stores.writeback(reject.resource as any, {
            upserts,
            deletes
        } as any)
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
