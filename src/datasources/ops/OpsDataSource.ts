import type { DeleteItem, Entity, FindManyOptions, IDataSource, PageInfo, PersistWriteback, StoreKey, UpsertWriteOptions } from '#core'
import { Batch, type BatchEngine } from '#batch'
import type { ObservabilityContext } from '#observability'
import { Protocol } from '#protocol'
import type { Meta, Operation, OperationResult, QueryResultData, WriteAction, WriteItem, WriteOptions, WriteResultData } from '#protocol'
import type { BatchQueryConfig, OpsDataSourceConfig } from './config/types'
import { normalizeAtomaServerQueryParams } from './protocol/queryParams'

type ParsedBatchConfig = {
    enabled: boolean
    endpoint?: string
    maxBatchSize?: number
    flushIntervalMs?: number
    devWarnings: boolean
}

/**
 * Protocol DataSource for ops-based APIs
 */
export class OpsDataSource<T extends Entity> implements IDataSource<T> {
    public readonly name: string
    private opSeq = 0
    private batchEngine?: BatchEngine
    private ownsBatchEngine: boolean
    private resource: string
    private readonly opsClient: OpsDataSourceConfig<T>['opsClient']

    constructor(private config: OpsDataSourceConfig<T>) {
        if (!config.resourceName) {
            throw new Error('[OpsDataSource] "resourceName" is required for ops routing')
        }

        if (!config.opsClient) {
            throw new Error('[OpsDataSource] "opsClient" is required')
        }

        this.ownsBatchEngine = false
        this.resource = this.normalizeResourceName(config.resourceName)

        this.opsClient = config.opsClient
        this.name = config.name ?? `ops:${this.resource}`

        if (config.batchEngine) {
            this.batchEngine = config.batchEngine
        } else {
            const batchConfig = this.parseBatchConfig(config.batch)
            if (batchConfig.enabled) {
                const endpointPath = batchConfig.endpoint ?? Protocol.http.paths.OPS
                this.batchEngine = Batch.create({
                    endpoint: endpointPath,
                    maxBatchSize: batchConfig.maxBatchSize,
                    flushIntervalMs: batchConfig.flushIntervalMs,
                    opsClient: this.opsClient,
                    onError: (error, payload) => {
                        this.onError(error, 'batch')
                        if (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'development') {
                            console.debug?.('[OpsDataSource:batch] payload failed', payload)
                        }
                    }
                })
                this.ownsBatchEngine = true

                if (batchConfig.devWarnings && typeof process !== 'undefined' && process?.env?.NODE_ENV === 'development') {
                    console.info(
                        `[Atoma] BatchQuery enabled for "${this.resource}" → ${endpointPath}\n` +
                        'Ensure backend exposes the ops endpoint. Set `batch:false` to disable.'
                    )
                }
            }
        }
    }

    dispose(): void {
        if (this.ownsBatchEngine) {
            this.batchEngine?.dispose()
        }
    }

    async put(key: StoreKey, value: T, internalContext?: ObservabilityContext): Promise<void> {
        const op = this.buildWriteOp('update', [{
            entityId: String(key),
            baseVersion: this.resolveBaseVersion(key, value),
            value
        }])
        await this.executeWriteExpectOk(op, internalContext, this.batchEngine ? 'put(batch)' : 'put(ops)')
    }

    async bulkPut(items: T[], internalContext?: ObservabilityContext): Promise<void> {
        if (!items.length) return
        const writeItems: WriteItem[] = items.map(item => ({
            entityId: String((item as any).id),
            baseVersion: this.resolveBaseVersion((item as any).id, item),
            value: item
        }))
        const op = this.buildWriteOp('update', writeItems)
        await this.executeWriteExpectOk(op, internalContext, this.batchEngine ? 'bulkPut(batch)' : 'bulkPut(ops)')
    }

    async bulkPutReturning(items: T[], internalContext?: ObservabilityContext): Promise<PersistWriteback<T> | void> {
        if (!items.length) return
        const keys: StoreKey[] = items.map(item => (item as any).id as StoreKey)
        const writeItems: WriteItem[] = items.map(item => ({
            entityId: String((item as any).id),
            baseVersion: this.resolveBaseVersion((item as any).id, item),
            value: item
        }))
        const op = this.buildWriteOp('update', writeItems)
        const data = await this.executeWriteExpectOk(op, internalContext, this.batchEngine ? 'bulkPutReturning(batch)' : 'bulkPutReturning(ops)')
        return this.collectPersistWriteback(keys, data)
    }

    async bulkCreate(items: T[], internalContext?: ObservabilityContext): Promise<T[] | void> {
        if (!items.length) return
        const writeItems: WriteItem[] = items.map(item => ({
            entityId: String((item as any)?.id),
            value: item
        }))
        const op = this.buildWriteOp('create', writeItems)
        const data = await this.executeWriteExpectOk(op, internalContext, this.batchEngine ? 'bulkCreate(batch)' : 'bulkCreate(ops)')
        const created = this.collectCreatedItems(data)
        return created.length ? created : undefined
    }

    async bulkCreateServerAssigned(items: Array<Partial<T>>, internalContext?: ObservabilityContext): Promise<T[] | void> {
        if (!items.length) return
        for (const item of items) {
            const id = (item as any)?.id
            if (id !== undefined && id !== null) {
                throw new Error('[OpsDataSource] bulkCreateServerAssigned does not allow client-provided id')
            }
        }
        const writeItems: WriteItem[] = items.map(item => ({
            value: item
        }))
        const op = this.buildWriteOp('create', writeItems)
        const data = await this.executeWriteExpectOk(op, internalContext, this.batchEngine ? 'bulkCreateServerAssigned(batch)' : 'bulkCreateServerAssigned(ops)')
        const created = this.collectCreatedItems(data)
        return created.length ? created : undefined
    }

    async delete(item: DeleteItem, internalContext?: ObservabilityContext): Promise<void> {
        const op = this.buildWriteOp('delete', [{
            entityId: String(item.id),
            baseVersion: item.baseVersion
        }])
        await this.executeWriteExpectOk(op, internalContext, this.batchEngine ? 'delete(batch)' : 'delete(ops)')
    }

    async bulkDelete(items: DeleteItem[], internalContext?: ObservabilityContext): Promise<void> {
        if (!items.length) return
        const writeItems: WriteItem[] = items.map(item => ({
            entityId: String(item.id),
            baseVersion: item.baseVersion
        }))
        const op = this.buildWriteOp('delete', writeItems)
        await this.executeWriteExpectOk(op, internalContext, this.batchEngine ? 'bulkDelete(batch)' : 'bulkDelete(ops)')
    }

    async bulkDeleteReturning(items: DeleteItem[], internalContext?: ObservabilityContext): Promise<PersistWriteback<T> | void> {
        if (!items.length) return
        const keys: StoreKey[] = items.map(item => item.id)
        const writeItems: WriteItem[] = items.map(item => ({
            entityId: String(item.id),
            baseVersion: item.baseVersion
        }))
        const op = this.buildWriteOp('delete', writeItems)
        const data = await this.executeWriteExpectOk(op, internalContext, this.batchEngine ? 'bulkDeleteReturning(batch)' : 'bulkDeleteReturning(ops)')
        return this.collectPersistWriteback(keys, data)
    }

    async upsert(key: StoreKey, value: T, options?: UpsertWriteOptions, internalContext?: ObservabilityContext): Promise<void> {
        const baseVersion = this.resolveOptionalBaseVersion(key, value)
        const writeOptions = this.buildUpsertWriteOptions(options)
        const op = this.buildWriteOp('upsert', [{
            entityId: String(key),
            ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
            value
        }], writeOptions)
        await this.executeWriteExpectOk(op, internalContext, this.batchEngine ? 'upsert(batch)' : 'upsert(ops)')
    }

    async bulkUpsert(items: T[], options?: UpsertWriteOptions, internalContext?: ObservabilityContext): Promise<void> {
        if (!items.length) return
        const writeOptions = this.buildUpsertWriteOptions(options)
        const writeItems: WriteItem[] = items.map(item => {
            const id = (item as any).id
            const baseVersion = this.resolveOptionalBaseVersion(id, item)
            return {
                entityId: String(id),
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: item
            }
        })
        const op = this.buildWriteOp('upsert', writeItems, writeOptions)
        await this.executeWriteExpectOk(op, internalContext, this.batchEngine ? 'bulkUpsert(batch)' : 'bulkUpsert(ops)')
    }

    async bulkUpsertReturning(
        items: T[],
        options?: UpsertWriteOptions,
        internalContext?: ObservabilityContext
    ): Promise<PersistWriteback<T> | void> {
        if (!items.length) return
        const keys: StoreKey[] = items.map(item => (item as any).id as StoreKey)
        const writeOptions = this.buildUpsertWriteOptions(options)
        const writeItems: WriteItem[] = items.map(item => {
            const id = (item as any).id
            const baseVersion = this.resolveOptionalBaseVersion(id, item)
            return {
                entityId: String(id),
                ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
                value: item
            }
        })
        const op = this.buildWriteOp('upsert', writeItems, writeOptions)
        const data = await this.executeWriteExpectOk(op, internalContext, this.batchEngine ? 'bulkUpsertReturning(batch)' : 'bulkUpsertReturning(ops)')
        return this.collectPersistWriteback(keys, data)
    }

    async get(key: StoreKey, internalContext?: ObservabilityContext): Promise<T | undefined> {
        const params: FindManyOptions<T> = {
            where: { id: key } as any,
            limit: 1,
            includeTotal: false
        }
        const { data } = await this.executeQueryExpectOk(this.buildQueryOp(params), internalContext, this.batchEngine ? 'get(batch)' : 'get(ops)')
        return data[0]
    }

    async bulkGet(keys: StoreKey[], internalContext?: ObservabilityContext): Promise<(T | undefined)[]> {
        if (!keys.length) return []

        const uniqueKeys = Array.from(new Set(keys))
        const params: FindManyOptions<T> = { where: { id: { in: uniqueKeys } } as any, skipStore: false }
        const { data } = await this.executeQueryExpectOk(this.buildQueryOp(params), internalContext, this.batchEngine ? 'bulkGet(batch)' : 'bulkGet(ops)')

        const map = new Map<StoreKey, T>()
        data.forEach(item => {
            const id = (item as any)?.id
            if (id !== undefined) map.set(id, item)
        })

        return keys.map(key => map.get(key))
    }

    async getAll(filter?: (item: T) => boolean, internalContext?: ObservabilityContext): Promise<T[]> {
        const { data } = await this.executeQueryExpectOk(this.buildQueryOp(undefined), internalContext, this.batchEngine ? 'getAll(batch)' : 'getAll(ops)')
        return filter ? data.filter(filter) : data
    }

    async findMany(
        options?: FindManyOptions<T>,
        internalContext?: ObservabilityContext
    ): Promise<{ data: T[]; pageInfo?: PageInfo; explain?: unknown }> {
        if (this.config.query?.customFn) {
            const res = await this.config.query.customFn(options || {} as any)
            return { data: res.data, pageInfo: res.pageInfo }
        }

        const { data, pageInfo } = await this.executeQueryExpectOk(
            this.buildQueryOp(options),
            internalContext,
            this.batchEngine ? 'findMany(batch)' : 'findMany(ops)'
        )
        return { data, pageInfo }
    }

    onError(error: Error, operation: string): void {
        console.error(`[OpsDataSource:${this.name}] Error in ${operation}:`, error)
    }

    private async executeOps(ops: Operation[], context?: ObservabilityContext): Promise<OperationResult[]> {
        if (this.batchEngine) {
            return await this.batchEngine.enqueueOps(ops, context)
        }

        const opsWithTrace = this.applyOpTraceMeta(ops as any, context) as Operation[]
        const meta: Meta = { v: 1, clientTimeMs: Date.now() }
        const result = await this.opsClient.executeOps({
            ops: opsWithTrace,
            meta,
            context
        })
        return result.results as any
    }

    private parseBatchConfig(batch?: boolean | BatchQueryConfig): ParsedBatchConfig {
        if (batch === true) {
            return { enabled: true, devWarnings: true }
        }
        if (batch === false) {
            return { enabled: false, devWarnings: true }
        }
        const cfg = batch || {}
        return {
            enabled: cfg.enabled !== false,
            endpoint: cfg.endpoint,
            maxBatchSize: cfg.maxBatchSize,
            flushIntervalMs: cfg.flushIntervalMs,
            devWarnings: cfg.devWarnings !== false
        }
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
        ;(err as any).error = result.error
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

export interface OpsDataSource<T extends Entity> extends IDataSource<T> {}
