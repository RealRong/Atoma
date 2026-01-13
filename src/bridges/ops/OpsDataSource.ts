import type { DeleteItem, Entity, FindManyOptions, IDataSource, PageInfo, PersistWriteback, StoreKey, UpsertWriteOptions } from '#core'
import type { ObservabilityContext } from '#observability'
import { Protocol } from '#protocol'
import type { Meta, Operation, OperationResult, QueryResultData, WriteAction, WriteItem, WriteOptions, WriteResultData } from '#protocol'
import type { OpsDataSourceConfig } from './config/types'
import { normalizeAtomaServerQueryParams } from './protocol/queryParams'

/**
 * Protocol DataSource for ops-based APIs
 */
export class OpsDataSource<T extends Entity> implements IDataSource<T> {
    public readonly name: string
    private opSeq = 0
    private resource: string
    private readonly opsClient: OpsDataSourceConfig<T>['opsClient']

    constructor(private config: OpsDataSourceConfig<T>) {
        if (!config.resourceName) {
            throw new Error('[OpsDataSource] "resourceName" is required for ops routing')
        }

        if (!config.opsClient) {
            throw new Error('[OpsDataSource] "opsClient" is required')
        }

        this.resource = this.normalizeResourceName(config.resourceName)
        this.opsClient = config.opsClient
        this.name = config.name ?? `ops:${this.resource}`
    }

    dispose(): void {
        // No-op: OpsClient now owns batch lifecycle
    }

    async put(key: StoreKey, value: T, internalContext?: ObservabilityContext): Promise<void> {
        return this.bulkPut([{ ...value as any, id: key }], internalContext)
    }

    async bulkPut(items: T[], internalContext?: ObservabilityContext): Promise<void> {
        if (!items.length) return
        const op = this.buildWriteOp('update', this.buildUpdateItems(items))
        await this.executeWriteExpectOk(op, internalContext, 'bulkPut')
    }

    async bulkPutReturning(items: T[], internalContext?: ObservabilityContext): Promise<PersistWriteback<T> | void> {
        if (!items.length) return
        const keys: StoreKey[] = items.map(item => (item as any).id as StoreKey)
        return this.executeWriteReturning('update', this.buildUpdateItems(items), keys, undefined, internalContext, 'bulkPutReturning')
    }

    async bulkCreate(items: T[], internalContext?: ObservabilityContext): Promise<T[] | void> {
        return this.executeWriteCreated(this.buildCreateItems(items, true), internalContext, 'bulkCreate')
    }

    async bulkCreateServerAssigned(items: Array<Partial<T>>, internalContext?: ObservabilityContext): Promise<T[] | void> {
        for (const item of items) {
            const id = (item as any)?.id
            if (id !== undefined && id !== null) {
                throw new Error('[OpsDataSource] bulkCreateServerAssigned does not allow client-provided id')
            }
        }
        return this.executeWriteCreated(this.buildCreateItems(items, false), internalContext, 'bulkCreateServerAssigned')
    }

    async delete(item: DeleteItem, internalContext?: ObservabilityContext): Promise<void> {
        return this.bulkDelete([item], internalContext)
    }

    async bulkDelete(items: DeleteItem[], internalContext?: ObservabilityContext): Promise<void> {
        if (!items.length) return
        const op = this.buildWriteOp('delete', this.buildDeleteItems(items))
        await this.executeWriteExpectOk(op, internalContext, 'bulkDelete')
    }

    async bulkDeleteReturning(items: DeleteItem[], internalContext?: ObservabilityContext): Promise<PersistWriteback<T> | void> {
        if (!items.length) return
        const keys: StoreKey[] = items.map(item => item.id)
        return this.executeWriteReturning('delete', this.buildDeleteItems(items), keys, undefined, internalContext, 'bulkDeleteReturning')
    }

    async upsert(key: StoreKey, value: T, options?: UpsertWriteOptions, internalContext?: ObservabilityContext): Promise<void> {
        return this.bulkUpsert([{ ...value as any, id: key }], options, internalContext)
    }

    async bulkUpsert(items: T[], options?: UpsertWriteOptions, internalContext?: ObservabilityContext): Promise<void> {
        if (!items.length) return
        const writeOptions = this.buildUpsertWriteOptions(options)
        const op = this.buildWriteOp('upsert', this.buildUpsertItems(items), writeOptions)
        await this.executeWriteExpectOk(op, internalContext, 'bulkUpsert')
    }

    async bulkUpsertReturning(
        items: T[],
        options?: UpsertWriteOptions,
        internalContext?: ObservabilityContext
    ): Promise<PersistWriteback<T> | void> {
        if (!items.length) return
        const keys: StoreKey[] = items.map(item => (item as any).id as StoreKey)
        const writeOptions = this.buildUpsertWriteOptions(options)
        return this.executeWriteReturning('upsert', this.buildUpsertItems(items), keys, writeOptions, internalContext, 'bulkUpsertReturning')
    }

    async get(key: StoreKey, internalContext?: ObservabilityContext): Promise<T | undefined> {
        const params: FindManyOptions<T> = {
            where: { id: key } as any,
            limit: 1,
            includeTotal: false
        }
        const { data } = await this.executeQueryExpectOk(this.buildQueryOp(params), internalContext, 'get')
        return data[0]
    }

    async bulkGet(keys: StoreKey[], internalContext?: ObservabilityContext): Promise<(T | undefined)[]> {
        if (!keys.length) return []

        const uniqueKeys = Array.from(new Set(keys))
        const params: FindManyOptions<T> = { where: { id: { in: uniqueKeys } } as any, skipStore: false }
        const { data } = await this.executeQueryExpectOk(this.buildQueryOp(params), internalContext, 'bulkGet')

        const map = new Map<StoreKey, T>()
        data.forEach(item => {
            const id = (item as any)?.id
            if (id !== undefined) map.set(id, item)
        })

        return keys.map(key => map.get(key))
    }

    async getAll(filter?: (item: T) => boolean, internalContext?: ObservabilityContext): Promise<T[]> {
        const { data } = await this.executeQueryExpectOk(this.buildQueryOp(undefined), internalContext, 'getAll')
        return filter ? data.filter(filter) : data
    }

    async findMany(
        options?: FindManyOptions<T>,
        internalContext?: ObservabilityContext
    ): Promise<{ data: T[]; pageInfo?: PageInfo; explain?: unknown }> {
        const { data, pageInfo } = await this.executeQueryExpectOk(
            this.buildQueryOp(options),
            internalContext,
            'findMany'
        )
        return { data, pageInfo }
    }

    private async executeWriteReturning(
        action: WriteAction,
        items: WriteItem[],
        keys: StoreKey[],
        writeOptions?: WriteOptions | undefined,
        internalContext?: ObservabilityContext,
        tag?: string
    ): Promise<PersistWriteback<T> | void> {
        if (!items.length) return
        const op = this.buildWriteOp(action, items, writeOptions)
        const data = await this.executeWriteExpectOk(op, internalContext, tag || action)
        return this.collectPersistWriteback(keys, data)
    }

    private async executeWriteCreated(
        items: WriteItem[],
        internalContext?: ObservabilityContext,
        tag?: string
    ): Promise<T[] | void> {
        if (!items.length) return
        const op = this.buildWriteOp('create', items)
        const data = await this.executeWriteExpectOk(op, internalContext, tag || 'create')
        const created = this.collectCreatedItems(data)
        return created.length ? created : undefined
    }

    onError(error: Error, operation: string): void {
        console.error(`[OpsDataSource:${this.name}] Error in ${operation}:`, error)
    }

    private async executeOps(ops: Operation[], context?: ObservabilityContext): Promise<OperationResult[]> {
        const opsWithTrace = this.applyOpTraceMeta(ops as any, context) as Operation[]
        const meta: Meta = { v: 1, clientTimeMs: Date.now() }
        const result = await this.opsClient.executeOps({
            ops: opsWithTrace,
            meta,
            context
        })
        return result.results as any
    }

    private normalizeResourceName(name?: string): string {
        if (!name) return 'unknown'
        const normalized = name.replace(/^\//, '')
        const parts = normalized.split('/')
        return parts[parts.length - 1] || 'unknown'
    }

    private applyOpTraceMeta(ops: any[], context?: ObservabilityContext): any[] {
        if (!context || !Array.isArray(ops) || !ops.length) return ops
        const traceId = (typeof context.traceId === 'string' && context.traceId) ? context.traceId : undefined
        if (!traceId) return ops

        return ops.map((op) => {
            if (!op || typeof op !== 'object') return op
            const requestId = context.requestId()
            const baseMeta = (op as any).meta
            const meta = (baseMeta && typeof baseMeta === 'object' && !Array.isArray(baseMeta))
                ? baseMeta
                : undefined
            return {
                ...(op as any),
                meta: {
                    v: 1,
                    ...(meta ? meta : {}),
                    traceId,
                    ...(requestId ? { requestId } : {})
                }
            }
        })
    }

    private resolveBaseVersion(id: StoreKey, value?: any): number {
        const versionFromValue = value && typeof value === 'object' ? (value as any).version : undefined
        if (typeof versionFromValue === 'number' && Number.isFinite(versionFromValue) && versionFromValue > 0) return versionFromValue
        throw new Error(`[OpsDataSource:${this.name}] update requires baseVersion (missing/invalid version for id=${String(id)})`)
    }

    private resolveOptionalBaseVersion(id: StoreKey, value?: any): number | undefined {
        const versionFromValue = value && typeof value === 'object' ? (value as any).version : undefined
        if (typeof versionFromValue === 'number' && Number.isFinite(versionFromValue) && versionFromValue > 0) return versionFromValue
        return undefined
    }

    private nextOpId(prefix: 'q' | 'w') {
        this.opSeq += 1
        return `${prefix}_${Date.now()}_${this.opSeq}`
    }

    private buildQueryOp(params: FindManyOptions<T> | undefined): Operation {
        return {
            opId: this.nextOpId('q'),
            kind: 'query',
            query: {
                resource: this.resource,
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

    // Helper methods to build WriteItems
    private buildUpdateItems(items: T[]): WriteItem[] {
        return items.map(item => ({
            entityId: String((item as any).id),
            baseVersion: this.resolveBaseVersion((item as any).id, item),
            value: item
        }))
    }

    private buildDeleteItems(items: DeleteItem[]): WriteItem[] {
        return items.map(item => ({
            entityId: String(item.id),
            baseVersion: item.baseVersion
        }))
    }

    private buildUpsertItems(items: T[]): WriteItem[] {
        return items.map(item => {
            const id = (item as any).id
            const baseVersion = this.resolveOptionalBaseVersion(id, item)
            return {
                entityId: String(id),
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: item
            }
        })
    }

    private buildCreateItems(items: Array<T | Partial<T>>, allowClientId: boolean): WriteItem[] {
        return items.map(item => ({
            ...(allowClientId && (item as any)?.id !== undefined ? { entityId: String((item as any).id) } : {}),
            value: item
        }))
    }

    private ensureWriteItemMeta(item: WriteItem): WriteItem {
        if (!item || typeof item !== 'object') return item
        const meta = (item as any).meta
        const baseMeta = (meta && typeof meta === 'object' && !Array.isArray(meta)) ? meta : {}
        const idempotencyKey = (typeof (baseMeta as any).idempotencyKey === 'string' && (baseMeta as any).idempotencyKey)
            ? (baseMeta as any).idempotencyKey
            : Protocol.ids.createIdempotencyKey({ now: () => Date.now() })
        const clientTimeMs = (typeof (baseMeta as any).clientTimeMs === 'number' && Number.isFinite((baseMeta as any).clientTimeMs))
            ? (baseMeta as any).clientTimeMs
            : Date.now()
        return {
            ...(item as any),
            meta: {
                ...baseMeta,
                idempotencyKey,
                clientTimeMs
            }
        } as WriteItem
    }

    private buildWriteOp(action: WriteAction, items: WriteItem[], options?: WriteOptions): Operation {
        const nextItems: WriteItem[] = items.map(item => this.ensureWriteItemMeta(item))
        return {
            opId: this.nextOpId('w'),
            kind: 'write',
            write: {
                resource: this.resource,
                action,
                items: nextItems,
                ...(options ? { options } : {})
            }
        }
    }

    private requireSingleResult(results: OperationResult[], missingMessage: string): OperationResult {
        const result = results[0]
        if (!result) throw new Error(missingMessage)
        return result
    }

    private toOpsError(result: OperationResult, tag: string): Error {
        if (result.ok) return new Error(`[${tag}] Operation failed`)
        const message = (result.error && typeof (result.error as any).message === 'string')
            ? (result.error as any).message
            : `[${tag}] Operation failed`
        const err = new Error(message)
            ; (err as any).error = result.error
        return err
    }

    private async executeQueryExpectOk(op: Operation, context: ObservabilityContext | undefined, tag: string): Promise<{ data: T[]; pageInfo?: PageInfo }> {
        const results = await this.executeOps([op], context)
        const result = this.requireSingleResult(results, 'Missing query result')
        if (!result.ok) throw this.toOpsError(result, tag)
        const data = result.data as QueryResultData
        return {
            data: Array.isArray(data.items) ? (data.items as T[]) : [],
            pageInfo: data.pageInfo
        }
    }

    private async executeWriteExpectOk(op: Operation, context: ObservabilityContext | undefined, tag: string): Promise<WriteResultData> {
        const results = await this.executeOps([op], context)
        const result = this.requireSingleResult(results, 'Missing write result')
        if (!result.ok) throw this.toOpsError(result, tag)
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

    private collectPersistWriteback(keys: StoreKey[], data: WriteResultData): PersistWriteback<T> | void {
        if (!data || !Array.isArray(data.results)) return

        const versionUpdates: Array<{ key: StoreKey; version: number }> = []
        const upserts: T[] = []

        data.results.forEach((res: any) => {
            if (!res || res.ok !== true) return

            const index = typeof res.index === 'number' ? res.index : -1
            const key = index >= 0 ? keys[index] : undefined
            const version = res.version

            if (key !== undefined && typeof version === 'number' && Number.isFinite(version) && version > 0) {
                versionUpdates.push({ key, version })
            }

            const value = res.data
            if (value && typeof value === 'object') {
                upserts.push(value as T)
            }
        })

        if (!versionUpdates.length && !upserts.length) return

        return {
            ...(upserts.length ? { upserts } : {}),
            ...(versionUpdates.length ? { versionUpdates } : {})
        }
    }
}

export interface OpsDataSource<T extends Entity> extends IDataSource<T> { }
