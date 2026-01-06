import { Core, applyStoreWriteback, type DeleteItem, type StoreKey } from '#core'
import type { ObservabilityContext } from '#observability'
import type { Change } from '#protocol'
import type { SyncApplier, SyncWriteAck, SyncWriteReject } from '#sync'
import { OpsDataSource } from '../../datasources'
import type { AtomaClientSyncConfig, ClientRuntime, ResolvedBackend } from '../types'

function normalizeStoreKeyFromEntityId(id: string): StoreKey {
    if (/^[0-9]+$/.test(id)) return Number(id)
    return id
}

export function createSyncReplicatorApplier(args: {
    runtime: ClientRuntime
    backend?: ResolvedBackend
    localBackend?: ResolvedBackend
    syncConfig?: AtomaClientSyncConfig
}): SyncApplier {
    const createRemoteDataSource = (resource: string) => {
        const backend = args.backend
        if (!backend) return null
        return new OpsDataSource<any>({
            opsClient: backend.opsClient,
            resourceName: resource,
            name: `${backend.key}:remote`,
            batch: false
        })
    }

    const createLocalDataSource = (resource: string) => {
        const backend = args.localBackend
        if (!backend) return null
        return new OpsDataSource<any>({
            opsClient: backend.opsClient,
            resourceName: resource,
            name: `${backend.key}:local`,
            batch: false
        })
    }

    const persistToLocal = async (
        resource: string,
        args2: { upserts?: any[]; deletes?: StoreKey[]; versionUpdates?: Array<{ key: StoreKey; version: number }> }
    ) => {
        const local = createLocalDataSource(resource)
        if (!local) return

        const upserts = Array.isArray(args2.upserts) ? args2.upserts : []
        const deletes = Array.isArray(args2.deletes) ? args2.deletes : []
        const versionUpdates = Array.isArray(args2.versionUpdates) ? args2.versionUpdates : []

        if (upserts.length) {
            await local.bulkUpsert(upserts as any[], { mode: 'loose', merge: false })
        }
        if (deletes.length) {
            const current = await local.bulkGet(deletes)
            const deleteItems: DeleteItem[] = []
            for (let i = 0; i < deletes.length; i++) {
                const id = deletes[i]
                const row = current[i]
                if (!row || typeof row !== 'object') continue
                const baseVersion = (row as any).version
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                    throw new Error(`[Atoma] local delete requires baseVersion (missing version for id=${String(id)})`)
                }
                deleteItems.push({ id, baseVersion })
            }
            if (deleteItems.length) {
                await local.bulkDelete(deleteItems)
            }
        }
        if (versionUpdates.length) {
            const versionByKey = new Map<StoreKey, number>()
            versionUpdates.forEach(v => versionByKey.set(v.key, v.version))

            const upsertedKeys = new Set<StoreKey>()
            upserts.forEach(u => {
                const id = (u as any)?.id
                if (id !== undefined) upsertedKeys.add(id)
            })

            const toUpdate = Array.from(versionByKey.entries())
                .filter(([key]) => !upsertedKeys.has(key))
                .map(([key]) => key)

            if (toUpdate.length) {
                const current = await local.bulkGet(toUpdate)
                const patched: any[] = []
                for (let i = 0; i < toUpdate.length; i++) {
                    const key = toUpdate[i]
                    const row = current[i]
                    const nextVersion = versionByKey.get(key)
                    if (!row || nextVersion === undefined) continue
                    if (row && typeof row === 'object') {
                        patched.push({ ...(row as any), version: nextVersion })
                    }
                }
                if (patched.length) {
                    await local.bulkPut(patched)
                }
            }
        }
    }

    async function applyPullChanges(changes: Change[]) {
        const list = Array.isArray(changes) ? changes : []
        if (!list.length) return

        const byResource = new Map<string, Change[]>()
        for (const change of list) {
            const existing = byResource.get(change.resource)
            if (existing) existing.push(change)
            else byResource.set(change.resource, [change])
        }

        for (const [resource, changesForResource] of byResource.entries()) {
            const store = args.runtime.resolveStore(resource)
            const handle = Core.store.getHandle(store)
            if (!handle) continue

            handle.services.mutation.control.remotePull({
                storeName: resource,
                changes: changesForResource
            })

            const deleteKeys: StoreKey[] = []
            const upsertEntityIds: string[] = []

            for (const c of changesForResource) {
                if (c.kind === 'delete') {
                    deleteKeys.push(normalizeStoreKeyFromEntityId(String(c.entityId)))
                    continue
                }
                upsertEntityIds.push(String(c.entityId))
            }

            const uniqueUpsertKeys = Array.from(new Set(upsertEntityIds)).map(id => normalizeStoreKeyFromEntityId(id))
            const uniqueDeleteKeys = Array.from(new Set(deleteKeys))

            const ctx: ObservabilityContext = handle.createObservabilityContext
                ? handle.createObservabilityContext({})
                : (undefined as any)

            const remote = createRemoteDataSource(resource)
            const upserts = (remote && uniqueUpsertKeys.length)
                ? (await remote.bulkGet(uniqueUpsertKeys, ctx)).filter((i: any): i is any => i !== undefined)
                : []

            await applyStoreWriteback(handle as any, {
                upserts,
                deletes: uniqueDeleteKeys
            })

            await persistToLocal(resource, {
                upserts,
                deletes: uniqueDeleteKeys
            })
        }
    }

    async function applyWriteAck(ack: SyncWriteAck): Promise<void> {
        const store = args.runtime.resolveStore(ack.resource)
        const handle = Core.store.getHandle(store)
        if (!handle) return
        const key = (ack.item as any)?.meta && typeof (ack.item as any).meta === 'object'
            ? (ack.item as any).meta.idempotencyKey
            : undefined
        handle.services.mutation.control.remoteAck({
            storeName: ack.resource,
            idempotencyKey: (typeof key === 'string' && key) ? key : undefined,
            ack
        })

        const upserts: any[] = []
        const deletes: StoreKey[] = []
        const versionUpdates: Array<{ key: StoreKey; version: number }> = []

        const version = ack.result.version
        if (typeof version === 'number' && Number.isFinite(version)) {
            versionUpdates.push({ key: normalizeStoreKeyFromEntityId(String(ack.result.entityId)), version })
        }

        if (ack.action === 'create') {
            const nextEntityId = ack.result.entityId
            const nextKey = normalizeStoreKeyFromEntityId(String(nextEntityId))

            const tempEntityId = (ack.item as any)?.entityId
            const tempKey = (typeof tempEntityId === 'string' && tempEntityId)
                ? normalizeStoreKeyFromEntityId(tempEntityId)
                : null

            if (tempKey !== null && tempKey !== nextKey) {
                throw new Error('[Atoma] sync: create ack returned mismatched id (client-id create must not change id)')
            }

            const before = handle.jotaiStore.get(handle.atom) as Map<StoreKey, any>
            const existing = before.get(nextKey)

            const serverData = ack.result.data
            const candidate = (serverData && typeof serverData === 'object')
                ? { ...(serverData as any) }
                : (existing && typeof existing === 'object')
                    ? { ...(existing as any) }
                    : undefined

            if (candidate) {
                candidate.id = nextKey as any
                if (typeof ack.result.version === 'number' && Number.isFinite(ack.result.version)) {
                    candidate.version = ack.result.version
                }
                upserts.push(candidate)
            }
        }

        await applyStoreWriteback(handle as any, {
            upserts,
            deletes,
            versionUpdates
        })

        await persistToLocal(ack.resource, {
            upserts,
            deletes,
            versionUpdates
        })
    }

    async function applyWriteReject(
        reject: SyncWriteReject,
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    ): Promise<void> {
        const store = args.runtime.resolveStore(reject.resource)
        const handle = Core.store.getHandle(store)
        if (!handle) return
        const key = (reject.item as any)?.meta && typeof (reject.item as any).meta === 'object'
            ? (reject.item as any).meta.idempotencyKey
            : undefined
        handle.services.mutation.control.remoteReject({
            storeName: reject.resource,
            idempotencyKey: (typeof key === 'string' && key) ? key : undefined,
            reject,
            reason: (reject.result as any)?.error ?? reject.result
        })
        const upserts: any[] = []
        const deletes: StoreKey[] = []

        if (reject.action === 'create') {
            const tempEntityId = (reject.item as any)?.entityId
            const tempKey = (typeof tempEntityId === 'string' && tempEntityId)
                ? normalizeStoreKeyFromEntityId(tempEntityId)
                : null
            if (tempKey !== null) {
                deletes.push(tempKey)
            }
        }

        const strategy = conflictStrategy ?? args.syncConfig?.conflictStrategy ?? 'server-wins'
        const error = (reject.result as any)?.error
        const current = (reject.result as any)?.current
        if (error?.code === 'CONFLICT' && current?.value && strategy === 'server-wins') {
            upserts.push(current.value)
        }

        await applyStoreWriteback(handle as any, { upserts, deletes })

        await persistToLocal(reject.resource, { upserts, deletes })
    }

    return {
        applyPullChanges,
        applyWriteAck,
        applyWriteReject
    }
}
