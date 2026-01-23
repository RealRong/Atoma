import type { ClientPluginContext } from 'atoma/client'
import type { DeleteItem } from 'atoma/core'
import { Protocol, type Change, type EntityId, type Operation, type OperationResult, type QueryParams, type QueryResultData, type WriteAction, type WriteItem, type WriteItemMeta, type WriteOptions, type WriteResultData } from 'atoma/protocol'
import type { SyncApplier, SyncWriteAck, SyncWriteReject } from '#sync/types'

type OpsClientLike = {
    executeOps: (input: any) => Promise<any>
}

function errorMessageFromStandardError(err: any, fallback: string): string {
    if (err && typeof err === 'object') {
        const msg = (err as any).message
        if (typeof msg === 'string' && msg) return msg
    }
    return fallback
}

export class WritebackApplier implements SyncApplier {
    private opSeq = 0

    constructor(private readonly deps: {
        ctx: ClientPluginContext
        remoteOpsClient: OpsClientLike
        /**
         * Optional durable mirror ops client:
         * - When provided, pull/ack/reject results are also persisted into this local backend.
         * - Keep it explicit to avoid guessing based on client runtime.
         */
        mirrorOpsClient?: OpsClientLike
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
        now: () => number
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

            const obs = this.deps.ctx.runtime.observability.createContext(resource)

            const upserts = uniqueUpsertKeys.length
                ? (await this.queryResource(this.deps.remoteOpsClient, { resource, params: { where: { id: { in: uniqueUpsertKeys } } } as any, context: obs })).items
                    .filter((i: any): i is any => i !== undefined)
                : []

            await this.deps.ctx.writeback.apply(resource, {
                upserts,
                deletes: uniqueDeleteKeys
            } as any)

            await this.persistToMirror(resource, { upserts, deletes: uniqueDeleteKeys })
        }
    }

    applyWriteAck = async (ack: SyncWriteAck) => {
        const key = (ack.item as any)?.meta && typeof (ack.item as any).meta === 'object'
            ? (ack.item as any).meta.idempotencyKey
            : undefined
        if (typeof key === 'string' && key) {
            this.deps.ctx.acks.ack(key)
        }

        const upserts: any[] = []
        const deletes: EntityId[] = []
        const versionUpdates: Array<{ key: EntityId; version: number }> = []

        const version = ack.result.version
        if (typeof version === 'number' && Number.isFinite(version)) {
            versionUpdates.push({ key: String(ack.result.entityId) as EntityId, version })
        }

        const serverData = ack.result.data
        if (serverData && typeof serverData === 'object') {
            upserts.push(serverData)
        }

        await this.deps.ctx.writeback.apply(ack.resource, { upserts, deletes, versionUpdates } as any)
        await this.persistToMirror(ack.resource, { upserts, deletes, versionUpdates })
    }

    applyWriteReject = async (
        reject: SyncWriteReject,
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    ) => {
        const key = (reject.item as any)?.meta && typeof (reject.item as any).meta === 'object'
            ? (reject.item as any).meta.idempotencyKey
            : undefined
        if (typeof key === 'string' && key) {
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

        await this.deps.ctx.writeback.apply(reject.resource, { upserts, deletes } as any)
        await this.persistToMirror(reject.resource, { upserts, deletes })
    }

    applyWriteResults = async (args: {
        acks: SyncWriteAck[]
        rejects: SyncWriteReject[]
        conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
        signal?: AbortSignal
    }) => {
        const acks = Array.isArray(args.acks) ? args.acks : []
        const rejects = Array.isArray(args.rejects) ? args.rejects : []

        for (const ack of acks) {
            if (args.signal?.aborted) return
            await this.applyWriteAck(ack)
        }
        for (const reject of rejects) {
            if (args.signal?.aborted) return
            await this.applyWriteReject(reject, args.conflictStrategy)
        }
    }

    private nextOpId = (prefix: 'q' | 'w') => {
        this.opSeq += 1
        return `${prefix}_${this.deps.now()}_${this.opSeq}`
    }

    private toProtocolValidationError = (error: unknown, fallbackMessage: string): Error => {
        const standard = Protocol.error.wrap(error, {
            code: 'INVALID_RESPONSE',
            message: fallbackMessage,
            kind: 'validation'
        })
        const err = new Error(`[atoma-sync] ${standard.message}`)
        ;(err as any).error = standard
        return err
    }

    private executeOps = async (
        opsClient: OpsClientLike,
        ops: Operation[],
        context?: import('atoma/observability').ObservabilityContext
    ): Promise<OperationResult[]> => {
        const traceId = (typeof (context as any)?.traceId === 'string' && (context as any).traceId) ? (context as any).traceId : undefined
        const opsWithTrace = Protocol.ops.build.withTraceMeta({
            ops,
            traceId,
            ...(context ? { nextRequestId: (context as any).requestId } : {})
        })
        const meta = Protocol.ops.build.buildRequestMeta({
            now: this.deps.now,
            traceId,
            requestId: context ? (context as any).requestId() : undefined
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
        opsClient: OpsClientLike,
        args2: { resource: string; params: QueryParams; context?: any }
    ): Promise<{ items: any[]; pageInfo?: any }> => {
        const op: Operation = Protocol.ops.build.buildQueryOp({
            opId: this.nextOpId('q'),
            resource: args2.resource,
            params: args2.params
        })
        const results = await this.executeOps(opsClient, [op], args2.context)
        const result = results[0]
        if (!result) throw new Error('[atoma-sync] Missing query result')
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
        opsClient: OpsClientLike,
        args2: { resource: string; action: WriteAction; items: WriteItem[]; options?: WriteOptions; context?: any }
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
        if (!result) throw new Error('[atoma-sync] Missing write result')
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
        return Protocol.ops.meta.newWriteItemMeta({ now: this.deps.now })
    }

    private desiredBaseVersionFromTargetVersion = (version: unknown): number | undefined => {
        if (typeof version !== 'number' || !Number.isFinite(version) || version <= 1) return undefined
        return Math.floor(version) - 1
    }

    private persistToMirror = async (
        resource: string,
        args2: { upserts?: any[]; deletes?: EntityId[]; versionUpdates?: Array<{ key: EntityId; version: number }> }
    ) => {
        const mirrorOpsClient = this.deps.mirrorOpsClient
        if (!mirrorOpsClient) return

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
                await this.writeResource(mirrorOpsClient, {
                    resource,
                    action: 'upsert',
                    items,
                    options: { merge: false, upsert: { mode: 'loose' } }
                })
            }
        }
        if (deletes.length) {
            const { items: currentItems } = await this.queryResource(mirrorOpsClient, {
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
                    throw new Error(`[atoma-sync] mirror delete requires baseVersion (missing version for id=${String(id)})`)
                }
                deleteItems.push({ id, baseVersion })
            }
            if (deleteItems.length) {
                const items: WriteItem[] = deleteItems.map(d => ({
                    entityId: d.id,
                    baseVersion: d.baseVersion,
                    meta: this.newWriteItemMeta()
                } as any))
                await this.writeResource(mirrorOpsClient, { resource, action: 'delete', items })
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
                const { items: currentItems } = await this.queryResource(mirrorOpsClient, {
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
                    await this.writeResource(mirrorOpsClient, {
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

