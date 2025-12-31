import { Patch, applyPatches } from 'immer'
import type { FindManyOptions, PageInfo, PatchMetadata, StoreKey, UpsertWriteOptions } from '#core'
import type { ObservabilityContext } from '#observability'
import type { Operation, OperationResult, QueryResultData, WriteAction, WriteItem, WriteOptions, WriteResultData } from '#protocol'
import { Protocol } from '#protocol'
import { normalizeAtomaServerQueryParams } from './protocol/queryParams'
import type { BatchEngine } from '#batch'

type ResolveBaseVersion = (id: StoreKey, value?: any) => number

type OperationRouterDeps<T> = {
    resource: string
    batch?: BatchEngine
    opsExecute: (ops: Operation[], context?: ObservabilityContext) => Promise<OperationResult[]>
    resolveBaseVersion: ResolveBaseVersion
    onError: (error: Error, operation: string) => void
    now?: () => number
    queryCustomFn?: (options: FindManyOptions<T>) => Promise<{ data: T[]; pageInfo?: PageInfo }>
}

export class OperationRouter<T> {
    private opSeq = 0

    constructor(private deps: OperationRouterDeps<T>) {}

    async upsert(key: StoreKey, value: T, options?: UpsertWriteOptions, context?: ObservabilityContext): Promise<void> {
        const baseVersion = this.resolveOptionalBaseVersion(key, value)
        const writeOptions = this.buildUpsertWriteOptions(options)
        const op = this.buildWriteOp('upsert', [{
            entityId: String(key),
            ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
            value,
            meta: this.clientMeta()
        }], writeOptions)
        const errorTag = this.deps.batch ? 'upsert(batch)' : 'upsert(ops)'
        await this.executeWriteAuto(op, context, errorTag)
    }

    async bulkUpsert(items: T[], options?: UpsertWriteOptions, context?: ObservabilityContext): Promise<void> {
        if (!items.length) return
        if (!this.deps.batch) {
            await Promise.all(items.map(item => this.upsert((item as any).id, item, options, context)))
            return
        }

        const writeOptions = this.buildUpsertWriteOptions(options)
        const writeItems: WriteItem[] = items.map(item => {
            const id = (item as any).id
            const baseVersion = this.resolveOptionalBaseVersion(id, item)
            return {
                entityId: String(id),
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: item,
                meta: this.clientMeta()
            }
        })

        const op = this.buildWriteOp('upsert', writeItems, writeOptions)
        await this.executeWriteAuto(op, context, 'bulkUpsert(batch)')
    }

    async put(key: StoreKey, value: T, context?: ObservabilityContext): Promise<void> {
        if (this.deps.batch) {
            try {
                const baseVersion = this.deps.resolveBaseVersion(key, value)
                const op = this.buildWriteOp('update', [{
                    entityId: String(key),
                    baseVersion,
                    value,
                    meta: this.clientMeta()
                }])
                await this.executeWriteAuto(op, context, 'put(batch)')
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
            meta: this.clientMeta()
        }])
        await this.executeWriteAuto(op, context, 'put(ops)')
    }

    async bulkPut(items: T[], context?: ObservabilityContext): Promise<void> {
        if (this.deps.batch) {
            if (!items.length) return
            const writeItems: WriteItem[] = items.map(item => ({
                entityId: String((item as any).id),
                baseVersion: this.deps.resolveBaseVersion((item as any).id, item),
                value: item,
                meta: this.clientMeta()
            }))
            const op = this.buildWriteOp('update', writeItems)
            await this.executeWriteAuto(op, context, 'bulkPut(batch)')
            return
        }
        if (!items.length) return
        await Promise.all(items.map(item => this.put((item as any).id, item, context)))
    }

    async bulkCreate(items: T[], context?: ObservabilityContext): Promise<T[] | void> {
        if (!items.length) return
        const writeItems: WriteItem[] = items.map(item => {
            const entityId = (item as any)?.id
            return {
                ...(entityId !== undefined ? { entityId: String(entityId) } : {}),
                value: item,
                meta: this.clientMeta()
            } as WriteItem
        })
        const op = this.buildWriteOp('create', writeItems)
        const errorTag = this.deps.batch ? 'bulkCreate(batch)' : 'bulkCreate(ops)'
        const data = await this.executeWriteAuto(op, context, errorTag)
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
                    meta: this.clientMeta()
                }])
                await this.executeWriteAuto(op, context, 'delete(batch)')
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
            meta: this.clientMeta()
        }])
        await this.executeWriteAuto(op, context, 'delete(ops)')
    }

    async bulkDelete(keys: StoreKey[], context?: ObservabilityContext): Promise<void> {
        if (this.deps.batch) {
            if (!keys.length) return
            const writeItems: WriteItem[] = keys.map(key => ({
                entityId: String(key),
                baseVersion: this.deps.resolveBaseVersion(key),
                meta: this.clientMeta()
            }))
            const op = this.buildWriteOp('delete', writeItems)
            await this.executeWriteAuto(op, context, 'bulkDelete(batch)')
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
        const patchesByItemId = new Map<StoreKey, Patch[]>()
        patches.forEach(patch => {
            const itemId = patch.path[0] as StoreKey
            if (!patchesByItemId.has(itemId)) patchesByItemId.set(itemId, [])
            patchesByItemId.get(itemId)!.push(patch)
        })

        const built = await this.buildPatchWriteOps(patchesByItemId, metadata, context)
        if (!built) return

        const errorTag = this.deps.batch ? 'applyPatches(batch)' : 'applyPatches(ops)'
        const results = await this.executeOpsAuto(built.ops, context, errorTag)

        const createdResults: T[] = []
        results.forEach((res, index) => {
            if (!res.ok) throw this.toBatchError(res, errorTag)
            if (built.opKinds[index] === 'create') {
                createdResults.push(...this.collectCreatedItems(res.data as WriteResultData))
            }
        })

        if (createdResults.length) return { created: createdResults }
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

    private buildUpsertWriteOptions(options?: UpsertWriteOptions): WriteOptions | undefined {
        const mode = options?.mode
        const merge = options?.merge
        const out: WriteOptions = {}
        if (typeof merge === 'boolean') out.merge = merge
        if (mode === 'strict' || mode === 'loose') out.upsert = { mode }
        return Object.keys(out).length ? out : undefined
    }

    private resolveOptionalBaseVersion(id: StoreKey, value?: any): number | undefined {
        const v = this.deps.resolveBaseVersion(id, value)
        if (!(typeof v === 'number' && Number.isFinite(v))) return undefined
        if (v <= 0) return undefined
        return v
    }

    private buildWriteOp(action: WriteAction, items: WriteItem[], options?: WriteOptions): Operation {
        const nextItems: WriteItem[] = items.map(item => this.ensureWriteItemMeta(item))
        return {
            opId: this.nextOpId('w'),
            kind: 'write',
            write: {
                resource: this.deps.resource,
                action,
                items: nextItems,
                ...(options ? { options } : {})
            }
        }
    }

    private async buildPatchWriteOps(
        patchesByItemId: Map<StoreKey, Patch[]>,
        metadata: PatchMetadata,
        context: ObservabilityContext | undefined
    ): Promise<{ ops: Operation[]; opKinds: Array<'create' | 'update' | 'delete'> } | undefined> {
        const createItems: WriteItem[] = []
        const updateItems: WriteItem[] = []
        const deleteItems: WriteItem[] = []

        for (const [id, itemPatches] of patchesByItemId.entries()) {
            const isDelete = itemPatches.some(p => p.op === 'remove' && p.path.length === 1)
            if (isDelete) {
                const baseVersion = this.deps.resolveBaseVersion(id)
                deleteItems.push({
                    entityId: String(id),
                    baseVersion,
                    meta: this.clientMeta(metadata.timestamp)
                })
                continue
            }

            const rootAdd = itemPatches.find(p => p.op === 'add' && p.path.length === 1)
            if (rootAdd) {
                createItems.push({
                    entityId: String(id),
                    value: rootAdd.value,
                    meta: this.clientMeta(metadata.timestamp)
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
                meta: this.clientMeta(metadata.timestamp)
            })
        }

        const ops: Operation[] = []
        const opKinds: Array<'create' | 'update' | 'delete'> = []

        if (createItems.length) {
            ops.push(this.buildWriteOp('create', createItems))
            opKinds.push('create')
        }
        if (updateItems.length) {
            ops.push(this.buildWriteOp('update', updateItems))
            opKinds.push('update')
        }
        if (deleteItems.length) {
            ops.push(this.buildWriteOp('delete', deleteItems))
            opKinds.push('delete')
        }

        if (!ops.length) return
        return { ops, opKinds }
    }

    private async executeQueryAuto(
        op: Operation,
        context: ObservabilityContext | undefined,
        errorTag: string
    ): Promise<{ data: T[]; pageInfo?: PageInfo }> {
        const results = await this.executeOpsAuto([op], context, errorTag)
        const result = this.requireSingleResult(results, 'Missing query result')
        if (!result.ok) throw this.toBatchError(result, errorTag)
        const data = result.data as QueryResultData
        return {
            data: Array.isArray(data.items) ? (data.items as T[]) : [],
            pageInfo: data.pageInfo
        }
    }

    private async executeWriteAuto(
        op: Operation,
        context: ObservabilityContext | undefined,
        errorTag: string
    ): Promise<WriteResultData> {
        const results = await this.executeOpsAuto([op], context, errorTag)
        const result = this.requireSingleResult(results, 'Missing write result')
        if (!result.ok) throw this.toBatchError(result, errorTag)
        return result.data as WriteResultData
    }

    private async executeOpsAuto(
        ops: Operation[],
        context: ObservabilityContext | undefined,
        errorTag: string
    ): Promise<OperationResult[]> {
        if (this.deps.batch) {
            return await this.executeBatchOps(ops, context, errorTag)
        }
        return await this.executeDirectOps(ops, context, errorTag)
    }

    private requireSingleResult(results: OperationResult[], missingMessage: string): OperationResult {
        const result = results[0]
        if (!result) throw new Error(missingMessage)
        return result
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
        const op = this.buildQueryOp(params)
        return await this.executeQueryAuto(op, context, errorTag)
    }

    private now() {
        return this.deps.now ? this.deps.now() : Date.now()
    }

    private clientMeta(timestampMs?: number) {
        return { clientTimeMs: timestampMs ?? this.now() }
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
