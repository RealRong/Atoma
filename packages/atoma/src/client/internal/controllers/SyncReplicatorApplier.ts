import type { DeleteItem } from '#core'
import type { ObservabilityContext } from '#observability'
import { Protocol, type Change, type EntityId, type Operation, type OperationResult, type QueryParams, type QueryResultData, type WriteAction, type WriteItem, type WriteItemMeta, type WriteOptions, type WriteResultData } from '#protocol'
import type { SyncApplier, SyncWriteAck, SyncWriteReject } from 'atoma-sync'
import type { AtomaClientSyncConfig, ResolvedBackend } from '#client/types'
import type { ClientRuntimeInternal } from '#client/internal/types'

function errorMessageFromStandardError(err: any, fallback: string): string {
    if (err && typeof err === 'object') {
        const msg = (err as any).message
        if (typeof msg === 'string' && msg) return msg
    }
    return fallback
}

export class SyncReplicatorApplier implements SyncApplier {
    private opSeq = 0

    constructor(
        private readonly runtime: ClientRuntimeInternal,
        private readonly backend?: ResolvedBackend,
        private readonly localBackend?: ResolvedBackend,
        private readonly syncConfig?: AtomaClientSyncConfig
    ) {}

    private toProtocolValidationError = (error: unknown, fallbackMessage: string): Error => {
        const standard = Protocol.error.wrap(error, {
            code: 'INVALID_RESPONSE',
            message: fallbackMessage,
            kind: 'validation'
        })
        const err = new Error(`[Atoma] sync: ${standard.message}`)
        ;(err as any).error = standard
        return err
    }

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

            const ctx: ObservabilityContext = this.runtime.observability.createContext(resource)

            const remoteOpsClient = this.backend?.opsClient
            const upserts = (remoteOpsClient && uniqueUpsertKeys.length)
                ? (await this.queryResource(remoteOpsClient, { resource, params: { where: { id: { in: uniqueUpsertKeys } } } as any, context: ctx })).items
                    .filter((i: any): i is any => i !== undefined)
                : []

            await this.runtime.internal.applyWriteback(resource, {
                upserts,
                deletes: uniqueDeleteKeys
            })

            await this.persistToLocal(resource, {
                upserts,
                deletes: uniqueDeleteKeys
            })
        }
    }

    applyWriteAck = async (ack: SyncWriteAck) => {
        const key = (ack.item as any)?.meta && typeof (ack.item as any).meta === 'object'
            ? (ack.item as any).meta.idempotencyKey
            : undefined
        if (typeof key === 'string' && key) {
            this.runtime.mutation.acks.ack(key)
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

            const before = this.runtime.internal.getStoreSnapshot(ack.resource)
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

        await this.runtime.internal.applyWriteback(ack.resource, {
            upserts,
            deletes,
            versionUpdates
        })

        await this.persistToLocal(ack.resource, {
            upserts,
            deletes,
            versionUpdates
        })
    }

    applyWriteReject = async (
        reject: SyncWriteReject,
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    ) => {
        const key = (reject.item as any)?.meta && typeof (reject.item as any).meta === 'object'
            ? (reject.item as any).meta.idempotencyKey
            : undefined
        if (typeof key === 'string' && key) {
            this.runtime.mutation.acks.reject(key, (reject.result as any)?.error ?? reject.result)
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

        const strategy = conflictStrategy ?? this.syncConfig?.engine?.push?.conflictStrategy ?? 'server-wins'
        const error = (reject.result as any)?.error
        const current = (reject.result as any)?.current
        if (error?.code === 'CONFLICT' && current?.value && strategy === 'server-wins') {
            upserts.push(current.value)
        }

        await this.runtime.internal.applyWriteback(reject.resource, { upserts, deletes })

        await this.persistToLocal(reject.resource, { upserts, deletes })
    }

    private nextOpId = (prefix: 'q' | 'w') => {
        this.opSeq += 1
        return `${prefix}_${Date.now()}_${this.opSeq}`
    }

    private executeOps = async (
        opsClient: ResolvedBackend['opsClient'],
        ops: Operation[],
        context?: ObservabilityContext
    ): Promise<OperationResult[]> => {
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
        Protocol.ops.validate.assertOutgoingOps({ ops: opsWithTrace, meta })
        const res = await opsClient.executeOps({ ops: opsWithTrace, meta, context })
        try {
            return Protocol.ops.validate.assertOperationResults((res as any).results)
        } catch (error) {
            throw this.toProtocolValidationError(error, 'Invalid ops response')
        }
    }

    private queryResource = async (
        opsClient: ResolvedBackend['opsClient'],
        args2: { resource: string; params: QueryParams; context?: ObservabilityContext }
    ): Promise<{ items: any[]; pageInfo?: any }> => {
        const op: Operation = Protocol.ops.build.buildQueryOp({
            opId: this.nextOpId('q'),
            resource: args2.resource,
            params: args2.params
        })
        const results = await this.executeOps(opsClient, [op], args2.context)
        const result = results[0]
        if (!result) throw new Error('[Atoma] Missing query result')
        let parsedResult: OperationResult
        try {
            parsedResult = Protocol.ops.validate.assertOperationResult(result)
        } catch (error) {
            throw this.toProtocolValidationError(error, 'Invalid query result')
        }
        if (parsedResult.ok !== true) {
            const errObj = parsedResult.error
            const err = new Error(errorMessageFromStandardError(errObj, 'Query failed'))
            ;(err as any).error = errObj
            throw err
        }

        let data: QueryResultData
        try {
            data = Protocol.ops.validate.assertQueryResultData(parsedResult.data) as QueryResultData
        } catch (error) {
            throw this.toProtocolValidationError(error, 'Invalid query result data')
        }
        return {
            items: (data as any).items as any[],
            pageInfo: (data as any)?.pageInfo
        }
    }

    private writeResource = async (
        opsClient: ResolvedBackend['opsClient'],
        args2: { resource: string; action: WriteAction; items: WriteItem[]; options?: WriteOptions; context?: ObservabilityContext }
    ): Promise<WriteResultData> => {
        const op: Operation = Protocol.ops.build.buildWriteOp({
            opId: this.nextOpId('w'),
            write: {
                resource: args2.resource,
                action: args2.action,
                items: args2.items,
                ...(args2.options ? { options: args2.options } : {})
            }
        })
        const results = await this.executeOps(opsClient, [op], args2.context)
        const result = results[0]
        if (!result) throw new Error('[Atoma] Missing write result')
        let parsedResult: OperationResult
        try {
            parsedResult = Protocol.ops.validate.assertOperationResult(result)
        } catch (error) {
            throw this.toProtocolValidationError(error, 'Invalid write result')
        }
        if (parsedResult.ok !== true) {
            const errObj = parsedResult.error
            const err = new Error(errorMessageFromStandardError(errObj, 'Write failed'))
            ;(err as any).error = errObj
            throw err
        }

        let data: WriteResultData
        try {
            data = Protocol.ops.validate.assertWriteResultData(parsedResult.data) as WriteResultData
        } catch (error) {
            throw this.toProtocolValidationError(error, 'Invalid write result data')
        }

        const itemResults = Array.isArray((data as any)?.results) ? ((data as any).results as any[]) : []
        for (const r of itemResults) {
            if (r.ok === true) continue
            const msg = errorMessageFromStandardError((r as any).error, 'Write failed')
            const err = new Error(msg)
            ;(err as any).error = (r as any).error
            ;(err as any).current = (r as any).current
            throw err
        }

        return data
    }

    private newWriteItemMeta = (): WriteItemMeta => {
        return Protocol.ops.meta.newWriteItemMeta({ now: () => Date.now() })
    }

    private desiredBaseVersionFromTargetVersion = (version: unknown): number | undefined => {
        if (typeof version !== 'number' || !Number.isFinite(version) || version <= 1) return undefined
        return Math.floor(version) - 1
    }

    private persistToLocal = async (
        resource: string,
        args2: { upserts?: any[]; deletes?: EntityId[]; versionUpdates?: Array<{ key: EntityId; version: number }> }
    ) => {
        const localOpsClient = this.localBackend?.opsClient
        if (!localOpsClient) return

        const upserts = Array.isArray(args2.upserts) ? args2.upserts : []
        const deletes = Array.isArray(args2.deletes) ? args2.deletes : []
        const versionUpdates = Array.isArray(args2.versionUpdates) ? args2.versionUpdates : []

        if (upserts.length) {
            const items: WriteItem[] = []
            for (const u of upserts) {
                const id = (u as any)?.id
                if (typeof id !== 'string' || !id) continue
                const baseVersion = this.desiredBaseVersionFromTargetVersion((u as any)?.version)
                items.push({
                    entityId: id,
                    ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                    value: u,
                    meta: this.newWriteItemMeta()
                } as any)
            }
            if (items.length) {
                await this.writeResource(localOpsClient, {
                    resource,
                    action: 'upsert',
                    items,
                    options: { merge: false, upsert: { mode: 'loose' } }
                })
            }
        }
        if (deletes.length) {
            const { items: currentItems } = await this.queryResource(localOpsClient, {
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
                    meta: this.newWriteItemMeta()
                } as any))
                await this.writeResource(localOpsClient, { resource, action: 'delete', items })
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
                const { items: currentItems } = await this.queryResource(localOpsClient, {
                    resource,
                    params: { where: { id: { in: toUpdate } } } as any
                })

                const items: WriteItem[] = []
                for (const row of currentItems) {
                    const id = (row as any)?.id
                    if (typeof id !== 'string' || !id) continue
                    const nextVersion = versionByKey.get(id)
                    if (nextVersion === undefined) continue

                    const baseVersion = this.desiredBaseVersionFromTargetVersion(nextVersion)
                    items.push({
                        entityId: id,
                        ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                        value: { ...(row as any), version: nextVersion },
                        meta: this.newWriteItemMeta()
                    } as any)
                }

                if (items.length) {
                    await this.writeResource(localOpsClient, {
                        resource,
                        action: 'upsert',
                        items,
                        options: { merge: true, upsert: { mode: 'loose' } }
                    })
                }
            }
        }
    }
}
