import type { ClientPluginContext } from 'atoma/client'
import type { Change, EntityId } from 'atoma/protocol'
import type { SyncApplier, SyncWriteAck, SyncWriteReject } from '#sync/types'

function idempotencyKeyFromWriteItem(item: unknown): string | undefined {
    const meta = (item as any)?.meta
    const key = (meta && typeof meta === 'object') ? (meta as any).idempotencyKey : undefined
    return (typeof key === 'string' && key) ? key : undefined
}

export class WritebackApplier implements SyncApplier {
    constructor(private readonly deps: {
        ctx: ClientPluginContext
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
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

            const obs = this.deps.ctx.observability.createContext(resource as any)

            const upserts = uniqueUpsertKeys.length
                ? (await this.deps.ctx.remote.query<any>({
                    store: resource as any,
                    params: { where: { id: { in: uniqueUpsertKeys } } } as any,
                    context: obs
                })).items.filter((i: any): i is any => i !== undefined)
                : []

            await this.deps.ctx.writeback.commit(resource as any, {
                upserts,
                deletes: uniqueDeleteKeys
            } as any, { context: obs })
        }
    }

    applyWriteAck = async (ack: SyncWriteAck) => {
        const key = idempotencyKeyFromWriteItem(ack.item)
        if (key) {
            this.deps.ctx.acks.ack(key)
        }

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

        const obs = this.deps.ctx.observability.createContext(ack.resource as any)
        await this.deps.ctx.writeback.commit(ack.resource as any, { upserts, deletes, versionUpdates } as any, { context: obs })
    }

    applyWriteReject = async (
        reject: SyncWriteReject,
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    ) => {
        const key = idempotencyKeyFromWriteItem(reject.item)
        if (key) {
            this.deps.ctx.acks.reject(key, (reject.result as any)?.error ?? reject.result)
        }

        const upserts: any[] = []
        const deletes: EntityId[] = []

        if (reject.action === 'create') {
            const tempEntityId = (reject.item as any)?.entityId
            const tempKey = (typeof tempEntityId === 'string' && tempEntityId)
                ? (tempEntityId as EntityId)
                : null
            if (tempKey !== null) {
                deletes.push(tempKey)
            }
        }

        const strategy = conflictStrategy ?? this.deps.conflictStrategy ?? 'server-wins'
        const error = (reject.result as any)?.error
        const current = (reject.result as any)?.current
        if (error?.code === 'CONFLICT' && current?.value && strategy === 'server-wins') {
            upserts.push(current.value)
        }

        const obs = this.deps.ctx.observability.createContext(reject.resource as any)
        await this.deps.ctx.writeback.commit(reject.resource as any, { upserts, deletes } as any, { context: obs })
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
            await this.applyWriteReject(reject, args?.conflictStrategy)
        }
    }
}

