import { Patch, applyPatches } from 'immer'
import type { FindManyOptions, PageInfo, PatchMetadata, StoreKey } from '#core'
import type { ObservabilityContext } from '#observability'
import type { Operation, OperationResult, QueryResultData, WriteAction, WriteItem, WriteResultData } from '#protocol'
import { Protocol } from '#protocol'
import { normalizeAtomaServerQueryParams } from '../transport/queryParams'
import type { BatchEngine } from '#batch'

type ResolveBaseVersion = (id: StoreKey, value?: any) => number

type OperationRouterDeps<T> = {
    resource: string
    batch?: BatchEngine
    opsExecute: (ops: Operation[], context?: ObservabilityContext) => Promise<OperationResult[]>
    usePatchForUpdate: boolean
    resolveBaseVersion: ResolveBaseVersion
    onError: (error: Error, operation: string) => void
    now?: () => number
    queryCustomFn?: (options: FindManyOptions<T>) => Promise<{ data: T[]; pageInfo?: PageInfo }>
}

export class OperationRouter<T> {
    private opSeq = 0

    constructor(private deps: OperationRouterDeps<T>) {}

    async put(key: StoreKey, value: T, context?: ObservabilityContext): Promise<void> {
        if (this.deps.batch) {
            try {
                const baseVersion = this.deps.resolveBaseVersion(key, value)
                const op = this.buildWriteOp('update', [{
                    entityId: String(key),
                    baseVersion,
                    value,
                    meta: { clientTimeMs: this.now() }
                }])
                await this.executeBatchWrite(op, context, 'put(batch)')
                return
            } catch (error) {
                this.deps.onError(error as Error, 'put(batch)')
                throw error
            }
        }

        const baseVersion = this.deps.resolveBaseVersion(key, value)
        const op = this.buildWriteOp('update', [{
            entityId: String(key),
            baseVersion,
            value,
            meta: { clientTimeMs: this.now() }
        }])
        await this.executeDirectWrite(op, context, 'put(ops)')
    }

    async bulkPut(items: T[], context?: ObservabilityContext): Promise<void> {
        if (this.deps.batch) {
            if (!items.length) return
            const writeItems: WriteItem[] = items.map(item => ({
                entityId: String((item as any).id),
                baseVersion: this.deps.resolveBaseVersion((item as any).id, item),
                value: item,
                meta: { clientTimeMs: this.now() }
            }))
            const op = this.buildWriteOp('update', writeItems)
            await this.executeBatchWrite(op, context, 'bulkPut(batch)')
            return
        }
        if (!items.length) return
        await Promise.all(items.map(item => this.put((item as any).id, item, context)))
    }

    async bulkCreate(items: T[], context?: ObservabilityContext): Promise<T[] | void> {
        if (this.deps.batch) {
            if (!items.length) return
            const writeItems: WriteItem[] = items.map(item => {
                const entityId = (item as any)?.id
                return {
                    ...(entityId !== undefined ? { entityId: String(entityId) } : {}),
                    value: item,
                    meta: { clientTimeMs: this.now() }
                } as WriteItem
            })
            const op = this.buildWriteOp('create', writeItems)
            const data = await this.executeBatchWrite(op, context, 'bulkCreate(batch)')
            const created = this.collectCreatedItems(data)
            return created.length ? created : undefined
        }

        if (!items.length) return
        const writeItems: WriteItem[] = items.map(item => {
            const entityId = (item as any)?.id
            return {
                ...(entityId !== undefined ? { entityId: String(entityId) } : {}),
                value: item,
                meta: { clientTimeMs: this.now() }
            } as WriteItem
        })
        const op = this.buildWriteOp('create', writeItems)
        const data = await this.executeDirectWrite(op, context, 'bulkCreate(ops)')
        const created = this.collectCreatedItems(data)
        return created.length ? created : undefined
    }

    async delete(key: StoreKey, context?: ObservabilityContext): Promise<void> {
        if (this.deps.batch) {
            try {
                const baseVersion = this.deps.resolveBaseVersion(key)
                const op = this.buildWriteOp('delete', [{
                    entityId: String(key),
                    baseVersion,
                    meta: { clientTimeMs: this.now() }
                }])
                await this.executeBatchWrite(op, context, 'delete(batch)')
                return
            } catch (error) {
                this.deps.onError(error as Error, 'delete(batch)')
                throw error
            }
        }

        const baseVersion = this.deps.resolveBaseVersion(key)
        const op = this.buildWriteOp('delete', [{
            entityId: String(key),
            baseVersion,
            meta: { clientTimeMs: this.now() }
        }])
        await this.executeDirectWrite(op, context, 'delete(ops)')
    }

    async bulkDelete(keys: StoreKey[], context?: ObservabilityContext): Promise<void> {
        if (this.deps.batch) {
            if (!keys.length) return
            const writeItems: WriteItem[] = keys.map(key => ({
                entityId: String(key),
                baseVersion: this.deps.resolveBaseVersion(key),
                meta: { clientTimeMs: this.now() }
            }))
            const op = this.buildWriteOp('delete', writeItems)
            await this.executeBatchWrite(op, context, 'bulkDelete(batch)')
            return
        }
        if (!keys.length) return
        await Promise.all(keys.map(k => this.delete(k, context)))
    }

    async get(key: StoreKey, context?: ObservabilityContext): Promise<T | undefined> {
        const params: FindManyOptions<T> = {
            where: { id: key } as any,
            limit: 1,
            includeTotal: false
        }
        const result = await this.queryWithBatchFallback(params, context, 'get(batch-fallback)')
        return result.data[0]
    }

    async bulkGet(keys: StoreKey[], context?: ObservabilityContext): Promise<(T | undefined)[]> {
        if (!keys.length) return []

        const uniqueKeys = Array.from(new Set(keys))
        const params: FindManyOptions<T> = { where: { id: { in: uniqueKeys } } as any, skipStore: false }
        const result = await this.queryWithBatchFallback(params, context, 'bulkGet(batch-fallback)')
        const data = result.data

        const map = new Map<StoreKey, T>()
        data.forEach(item => {
            const id = (item as any)?.id
            if (id !== undefined) map.set(id, item)
        })

        return keys.map(key => map.get(key))
    }

    async getAll(filter?: (item: T) => boolean, context?: ObservabilityContext): Promise<T[]> {
        const result = await this.queryWithBatchFallback(undefined, context, 'getAll(batch-fallback)')
        const data = result.data
        return filter ? data.filter(filter) : data
    }

    async findMany(
        options?: FindManyOptions<T>,
        context?: ObservabilityContext
    ): Promise<{ data: T[]; pageInfo?: PageInfo }> {
        if (this.deps.queryCustomFn) {
            return this.deps.queryCustomFn(options || {} as any)
        }
        return this.queryWithBatchFallback(options, context, 'findMany(batch-fallback)')
    }

    async applyPatches(
        patches: Patch[],
        metadata: PatchMetadata,
        context?: ObservabilityContext
    ): Promise<{ created?: T[] } | void> {
        const usePatchForUpdates = this.deps.usePatchForUpdate

        const patchesByItemId = new Map<StoreKey, Patch[]>()
        patches.forEach(patch => {
            const itemId = patch.path[0] as StoreKey
            if (!patchesByItemId.has(itemId)) patchesByItemId.set(itemId, [])
            patchesByItemId.get(itemId)!.push(patch)
        })

        if (this.deps.batch) {
            const createItems: WriteItem[] = []
            const updateItems: WriteItem[] = []
            const patchItems: WriteItem[] = []
            const deleteItems: WriteItem[] = []

            for (const [id, itemPatches] of patchesByItemId.entries()) {
                const isDelete = itemPatches.some(p => p.op === 'remove' && p.path.length === 1)
                if (isDelete) {
                    const baseVersion = this.deps.resolveBaseVersion(id)
                    deleteItems.push({
                        entityId: String(id),
                        baseVersion,
                        meta: { clientTimeMs: metadata.timestamp ?? this.now() }
                    })
                    continue
                }

                const rootAdd = itemPatches.find(p => p.op === 'add' && p.path.length === 1)
                if (rootAdd) {
                    createItems.push({
                        entityId: String(id),
                        value: rootAdd.value,
                        meta: { clientTimeMs: metadata.timestamp ?? this.now() }
                    })
                    continue
                }

                if (usePatchForUpdates) {
                    const baseVersion = this.deps.resolveBaseVersion(id)
                        patchItems.push({
                            entityId: String(id),
                            baseVersion,
                            patch: Protocol.jsonPatch.convertImmerPatchesToJsonPatches(itemPatches, id as any),
                            meta: { clientTimeMs: metadata.timestamp ?? this.now() }
                        })
                        continue
                    }

                const rootReplace = itemPatches.find(p => (p.op === 'add' || p.op === 'replace') && p.path.length === 1)
                let next: any
                if (rootReplace) {
                    next = rootReplace.value
                } else {
                    const current = await this.get(id, context)
                    if (current === undefined) throw new Error(`Item ${id} not found for put`)
                    next = applyPatches(current as any, itemPatches)
                }

                const baseVersion = this.deps.resolveBaseVersion(id, next)
                updateItems.push({
                    entityId: String(id),
                    baseVersion,
                    value: next,
                    meta: { clientTimeMs: metadata.timestamp ?? this.now() }
                })
            }

            const ops: Operation[] = []
            const opKinds: Array<'create' | 'update' | 'patch' | 'delete'> = []

            if (createItems.length) {
                ops.push(this.buildWriteOp('create', createItems))
                opKinds.push('create')
            }
            if (updateItems.length) {
                ops.push(this.buildWriteOp('update', updateItems))
                opKinds.push('update')
            }
            if (patchItems.length) {
                ops.push(this.buildWriteOp('patch', patchItems))
                opKinds.push('patch')
            }
            if (deleteItems.length) {
                ops.push(this.buildWriteOp('delete', deleteItems))
                opKinds.push('delete')
            }

            if (!ops.length) return

            const results = await this.executeBatchOps(ops, context, 'applyPatches(batch)')
            const createdResults: T[] = []

            results.forEach((res, index) => {
                if (!res.ok) {
                    throw this.toBatchError(res, 'applyPatches(batch)')
                }
                if (opKinds[index] === 'create') {
                    createdResults.push(...this.collectCreatedItems(res.data as WriteResultData))
                }
            })

            if (createdResults.length) {
                return { created: createdResults }
            }
            return
        }

        const createItems: WriteItem[] = []
        const updateItems: WriteItem[] = []
        const patchItems: WriteItem[] = []
        const deleteItems: WriteItem[] = []

        for (const [id, itemPatches] of patchesByItemId.entries()) {
            const isDelete = itemPatches.some(p => p.op === 'remove' && p.path.length === 1)
            if (isDelete) {
                const baseVersion = this.deps.resolveBaseVersion(id)
                deleteItems.push({
                    entityId: String(id),
                    baseVersion,
                    meta: { clientTimeMs: metadata.timestamp ?? this.now() }
                })
                continue
            }

            const rootAdd = itemPatches.find(p => p.op === 'add' && p.path.length === 1)
            if (rootAdd) {
                createItems.push({
                    entityId: String(id),
                    value: rootAdd.value,
                    meta: { clientTimeMs: metadata.timestamp ?? this.now() }
                })
                continue
            }

            if (usePatchForUpdates) {
                const baseVersion = this.deps.resolveBaseVersion(id)
                patchItems.push({
                    entityId: String(id),
                    baseVersion,
                    patch: Protocol.jsonPatch.convertImmerPatchesToJsonPatches(itemPatches, id as any),
                    meta: { clientTimeMs: metadata.timestamp ?? this.now() }
                })
                continue
            }

            const rootReplace = itemPatches.find(p => (p.op === 'add' || p.op === 'replace') && p.path.length === 1)
            let next: any
            if (rootReplace) {
                next = rootReplace.value
            } else {
                const current = await this.get(id, context)
                if (current === undefined) throw new Error(`Item ${id} not found for put`)
                next = applyPatches(current as any, itemPatches)
            }

            const baseVersion = this.deps.resolveBaseVersion(id, next)
            updateItems.push({
                entityId: String(id),
                baseVersion,
                value: next,
                meta: { clientTimeMs: metadata.timestamp ?? this.now() }
            })
        }

        const ops: Operation[] = []
        const opKinds: Array<'create' | 'update' | 'patch' | 'delete'> = []

        if (createItems.length) {
            ops.push(this.buildWriteOp('create', createItems))
            opKinds.push('create')
        }
        if (updateItems.length) {
            ops.push(this.buildWriteOp('update', updateItems))
            opKinds.push('update')
        }
        if (patchItems.length) {
            ops.push(this.buildWriteOp('patch', patchItems))
            opKinds.push('patch')
        }
        if (deleteItems.length) {
            ops.push(this.buildWriteOp('delete', deleteItems))
            opKinds.push('delete')
        }

        if (!ops.length) return

        const results = await this.executeDirectOps(ops, context, 'applyPatches(ops)')
        const createdResults: T[] = []

        results.forEach((res, index) => {
            if (!res.ok) {
                throw this.toBatchError(res, 'applyPatches(ops)')
            }
            if (opKinds[index] === 'create') {
                createdResults.push(...this.collectCreatedItems(res.data as WriteResultData))
            }
        })

        if (createdResults.length) {
            return { created: createdResults }
        }
    }

    private buildQueryOp(params: FindManyOptions<T> | undefined): Operation {
        return {
            opId: this.nextOpId('q'),
            kind: 'query',
            query: {
                resource: this.deps.resource,
                params: normalizeAtomaServerQueryParams(params)
            }
        }
    }

    private buildWriteOp(action: WriteAction, items: WriteItem[]): Operation {
        const nextItems: WriteItem[] = items.map(item => this.ensureWriteItemMeta(item))
        return {
            opId: this.nextOpId('w'),
            kind: 'write',
            write: {
                resource: this.deps.resource,
                action,
                items: nextItems
            }
        }
    }

    private async executeBatchOps(
        ops: Operation[],
        context: ObservabilityContext | undefined,
        errorTag: string
    ): Promise<OperationResult[]> {
        if (!this.deps.batch) {
            throw new Error('[OperationRouter] batch engine not initialized')
        }
        try {
            return await this.deps.batch.enqueueOps(ops, context)
        } catch (error) {
            this.deps.onError(error as Error, errorTag)
            throw error
        }
    }

    private async executeBatchWrite(
        op: Operation,
        context: ObservabilityContext | undefined,
        errorTag: string
    ): Promise<WriteResultData> {
        const results = await this.executeBatchOps([op], context, errorTag)
        const result = results[0]
        if (!result) {
            throw new Error('Missing write result')
        }
        if (!result.ok) {
            throw this.toBatchError(result, errorTag)
        }
        return result.data as WriteResultData
    }

    private async executeDirectOps(
        ops: Operation[],
        context: ObservabilityContext | undefined,
        errorTag: string
    ): Promise<OperationResult[]> {
        try {
            return await this.deps.opsExecute(ops, context)
        } catch (error) {
            this.deps.onError(error as Error, errorTag)
            throw error
        }
    }

    private async executeDirectWrite(
        op: Operation,
        context: ObservabilityContext | undefined,
        errorTag: string
    ): Promise<WriteResultData> {
        const results = await this.executeDirectOps([op], context, errorTag)
        const result = results[0]
        if (!result) {
            throw new Error('Missing write result')
        }
        if (!result.ok) {
            throw this.toBatchError(result, errorTag)
        }
        return result.data as WriteResultData
    }

    private collectCreatedItems(data: WriteResultData): T[] {
        if (!data || !Array.isArray(data.results)) return []
        const out: T[] = []
        data.results.forEach((res: any) => {
            if (res && res.ok === true && res.data && typeof res.data === 'object') {
                out.push(res.data as T)
            }
        })
        return out
    }

    private toBatchError(result: OperationResult, _tag: string): Error {
        if (result.ok) {
            return new Error('Batch operation failed')
        }
        const message = (result.error && typeof (result.error as any).message === 'string')
            ? (result.error as any).message
            : 'Batch operation failed'
        const err = new Error(message)
        ;(err as any).error = result.error
        return err
    }

    private async queryWithBatchFallback(
        params: FindManyOptions<T> | undefined,
        context: ObservabilityContext | undefined,
        errorTag: string
    ): Promise<{ data: T[]; pageInfo?: PageInfo }> {
        if (this.deps.batch) {
            try {
                const op = this.buildQueryOp(params)
                const [result] = await this.deps.batch.enqueueOps([op], context)
                if (!result) {
                    throw new Error('Missing query result')
                }
                if (!result.ok) {
                    throw this.toBatchError(result, errorTag)
                }
                const data = result.data as QueryResultData
                return {
                    data: Array.isArray(data.items) ? (data.items as T[]) : [],
                    pageInfo: data.pageInfo
                }
            } catch (error) {
                this.deps.onError(error as Error, errorTag)
                throw error
            }
        }

        const op = this.buildQueryOp(params)
        const [result] = await this.executeDirectOps([op], context, errorTag)
        if (!result) {
            throw new Error('Missing query result')
        }
        if (!result.ok) {
            throw this.toBatchError(result, errorTag)
        }
        const data = result.data as QueryResultData
        return {
            data: Array.isArray(data.items) ? (data.items as T[]) : [],
            pageInfo: data.pageInfo
        }
    }

    private now() {
        return this.deps.now ? this.deps.now() : Date.now()
    }

    private ensureWriteItemMeta(item: WriteItem): WriteItem {
        if (!item || typeof item !== 'object') return item
        const meta = (item as any).meta
        const baseMeta = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta : {}
        const idempotencyKey = (typeof (baseMeta as any).idempotencyKey === 'string' && (baseMeta as any).idempotencyKey)
            ? (baseMeta as any).idempotencyKey
            : Protocol.ids.createIdempotencyKey({ now: () => this.now() })
        return {
            ...(item as any),
            meta: {
                ...baseMeta,
                idempotencyKey
            }
        } as WriteItem
    }

    private nextOpId(prefix: 'q' | 'w') {
        this.opSeq += 1
        return `${prefix}_${Date.now()}_${this.opSeq}`
    }
}
