import { Core, applyStoreWriteback, type DeleteItem } from '#core'
import type { ObservabilityContext } from '#observability'
import { Protocol, type Change, type EntityId, type Meta, type Operation, type OperationResult, type QueryParams, type QueryResultData, type WriteAction, type WriteItem, type WriteItemMeta, type WriteOptions, type WriteResultData } from '#protocol'
import type { SyncApplier, SyncWriteAck, SyncWriteReject } from '#sync'
import type { AtomaClientSyncConfig, ClientRuntime, ResolvedBackend } from '../../types'

export function createSyncReplicatorApplier(args: {
    runtime: ClientRuntime
    backend?: ResolvedBackend
    localBackend?: ResolvedBackend
    syncConfig?: AtomaClientSyncConfig
}): SyncApplier {
    let opSeq = 0
    const nextOpId = (prefix: 'q' | 'w') => {
        opSeq += 1
        return `${prefix}_${Date.now()}_${opSeq}`
    }

    async function executeOps(opsClient: ResolvedBackend['opsClient'], ops: Operation[], context?: ObservabilityContext): Promise<OperationResult[]> {
        const traceId = (typeof context?.traceId === 'string' && context.traceId) ? context.traceId : undefined
        const opsWithTrace = Protocol.ops.build.withTraceMeta({
            ops,
            traceId,
            ...(context ? { nextRequestId: context.requestId } : {})
        })
        const meta = Protocol.ops.build.buildRequestMeta({
            now: () => Date.now(),
            traceId,
            requestId: context ? context.requestId() : undefined
        })
        Protocol.ops.validate.assertOutgoingOpsV1({ ops: opsWithTrace, meta })
        const res = await opsClient.executeOps({ ops: opsWithTrace, meta, context })
        return Array.isArray(res.results) ? (res.results as any) : []
    }

    async function queryResource(opsClient: ResolvedBackend['opsClient'], args2: { resource: string; params: QueryParams; context?: ObservabilityContext }): Promise<{ items: any[]; pageInfo?: any }> {
        const op: Operation = Protocol.ops.build.buildQueryOp({
            opId: nextOpId('q'),
            resource: args2.resource,
            params: args2.params
        })
        const results = await executeOps(opsClient, [op], args2.context)
        const result = results[0]
        if (!result) throw new Error('[Atoma] Missing query result')
        if ((result as any).ok !== true) {
            const errObj = (result as any).error
            const msg = (errObj && typeof errObj.message === 'string') ? errObj.message : 'Query failed'
            const err = new Error(msg)
            ;(err as any).error = errObj
            throw err
        }
        const data = (result as any).data as QueryResultData
        return {
            items: Array.isArray((data as any)?.items) ? ((data as any).items as any[]) : [],
            pageInfo: (data as any)?.pageInfo
        }
    }

    async function writeResource(opsClient: ResolvedBackend['opsClient'], args2: { resource: string; action: WriteAction; items: WriteItem[]; options?: WriteOptions; context?: ObservabilityContext }): Promise<WriteResultData> {
        const op: Operation = Protocol.ops.build.buildWriteOp({
            opId: nextOpId('w'),
            write: {
                resource: args2.resource,
                action: args2.action,
                items: args2.items,
                ...(args2.options ? { options: args2.options } : {})
            }
        })
        const results = await executeOps(opsClient, [op], args2.context)
        const result = results[0]
        if (!result) throw new Error('[Atoma] Missing write result')
        if ((result as any).ok !== true) {
            const errObj = (result as any).error
            const msg = (errObj && typeof errObj.message === 'string') ? errObj.message : 'Write failed'
            const err = new Error(msg)
            ;(err as any).error = errObj
            throw err
        }
        const data = (result as any).data as WriteResultData
        const itemResults = Array.isArray((data as any)?.results) ? ((data as any).results as any[]) : []
        for (const r of itemResults) {
            if (!r) continue
            if (r.ok === true) continue
            const msg = r.error && typeof r.error.message === 'string' ? r.error.message : 'Write failed'
            const err = new Error(msg)
            ;(err as any).error = r.error
            ;(err as any).current = r.current
            throw err
        }
        return data
    }

    function newWriteItemMeta(): WriteItemMeta {
        return Protocol.ops.meta.newWriteItemMeta({ now: () => Date.now() })
    }

    function desiredBaseVersionFromTargetVersion(version: unknown): number | undefined {
        if (typeof version !== 'number' || !Number.isFinite(version) || version <= 1) return undefined
        return Math.floor(version) - 1
    }

    const persistToLocal = async (
        resource: string,
        args2: { upserts?: any[]; deletes?: EntityId[]; versionUpdates?: Array<{ key: EntityId; version: number }> }
    ) => {
        const localOpsClient = args.localBackend?.opsClient
        if (!localOpsClient) return

        const upserts = Array.isArray(args2.upserts) ? args2.upserts : []
        const deletes = Array.isArray(args2.deletes) ? args2.deletes : []
        const versionUpdates = Array.isArray(args2.versionUpdates) ? args2.versionUpdates : []

        if (upserts.length) {
            const items: WriteItem[] = []
            for (const u of upserts) {
                const id = (u as any)?.id
                if (typeof id !== 'string' || !id) continue
                const baseVersion = desiredBaseVersionFromTargetVersion((u as any)?.version)
                items.push({
                    entityId: id,
                    ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                    value: u,
                    meta: newWriteItemMeta()
                } as any)
            }
            if (items.length) {
                await writeResource(localOpsClient, {
                    resource,
                    action: 'upsert',
                    items,
                    options: { merge: false, upsert: { mode: 'loose' } }
                })
            }
        }
        if (deletes.length) {
            const { items: currentItems } = await queryResource(localOpsClient, {
                resource,
                params: { where: { id: { in: deletes } } } as any
            })
            const currentById = new Map<EntityId, any>()
            for (const row of currentItems) {
                const id = (row as any)?.id
                if (typeof id === 'string' && id) currentById.set(id, row)
            }
            const deleteItems: DeleteItem[] = []
            for (let i = 0; i < deletes.length; i++) {
                const id = deletes[i]
                const row = currentById.get(id)
                if (!row || typeof row !== 'object') continue
                const baseVersion = (row as any).version
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                    throw new Error(`[Atoma] local delete requires baseVersion (missing version for id=${String(id)})`)
                }
                deleteItems.push({ id, baseVersion })
            }
            if (deleteItems.length) {
                const items: WriteItem[] = deleteItems.map(d => ({
                    entityId: d.id,
                    baseVersion: d.baseVersion,
                    meta: newWriteItemMeta()
                } as any))
                await writeResource(localOpsClient, { resource, action: 'delete', items })
            }
        }
        if (versionUpdates.length) {
            const versionByKey = new Map<EntityId, number>()
            versionUpdates.forEach(v => versionByKey.set(v.key, v.version))

            const upsertedKeys = new Set<EntityId>()
            upserts.forEach(u => {
                const id = (u as any)?.id
                if (typeof id === 'string' && id) upsertedKeys.add(id)
            })

            const toUpdate = Array.from(versionByKey.entries())
                .filter(([key]) => !upsertedKeys.has(key))
                .map(([key]) => key)

            if (toUpdate.length) {
                const { items: currentItems } = await queryResource(localOpsClient, {
                    resource,
                    params: { where: { id: { in: toUpdate } } } as any
                })

                const items: WriteItem[] = []
                for (const row of currentItems) {
                    const id = (row as any)?.id
                    if (typeof id !== 'string' || !id) continue
                    const nextVersion = versionByKey.get(id)
                    if (nextVersion === undefined) continue

                    const baseVersion = desiredBaseVersionFromTargetVersion(nextVersion)
                    items.push({
                        entityId: id,
                        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                        value: { ...(row as any), version: nextVersion },
                        meta: newWriteItemMeta()
                    } as any)
                }

                if (items.length) {
                    await writeResource(localOpsClient, {
                        resource,
                        action: 'upsert',
                        items,
                        options: { merge: true, upsert: { mode: 'loose' } }
                    })
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

            const ctx: ObservabilityContext = handle.createObservabilityContext
                ? handle.createObservabilityContext({})
                : (undefined as any)

            const remoteOpsClient = args.backend?.opsClient
            const upserts = (remoteOpsClient && uniqueUpsertKeys.length)
                ? (await queryResource(remoteOpsClient, { resource, params: { where: { id: { in: uniqueUpsertKeys } } } as any, context: ctx })).items
                    .filter((i: any): i is any => i !== undefined)
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
        if (typeof key === 'string' && key) {
            handle.services.mutation.acks.ack(key)
        }

        const upserts: any[] = []
        const deletes: EntityId[] = []
        const versionUpdates: Array<{ key: EntityId; version: number }> = []

        const version = ack.result.version
        if (typeof version === 'number' && Number.isFinite(version)) {
            versionUpdates.push({ key: String(ack.result.entityId) as EntityId, version })
        }

        if (ack.action === 'create') {
            const nextEntityId = ack.result.entityId
            const nextKey = String(nextEntityId) as EntityId

            const tempEntityId = (ack.item as any)?.entityId
            const tempKey = (typeof tempEntityId === 'string' && tempEntityId)
                ? (tempEntityId as EntityId)
                : null

            if (tempKey !== null && tempKey !== nextKey) {
                throw new Error('[Atoma] sync: create ack returned mismatched id (client-id create must not change id)')
            }

            const before = handle.jotaiStore.get(handle.atom) as Map<EntityId, any>
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
        if (typeof key === 'string' && key) {
            handle.services.mutation.acks.reject(key, (reject.result as any)?.error ?? reject.result)
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
