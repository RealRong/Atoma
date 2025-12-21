import { Patch, applyPatches } from 'immer'
import type { FindManyOptions, IAdapter, PatchMetadata, StoreKey, PageInfo, Entity, StoreAccess } from '../../../core/types'
import type { DevtoolsBridge } from '../../../devtools/types'
import { getGlobalDevtools } from '../../../devtools/global'
import { resolveConflict } from '../conflict'
import { makeUrl, RequestSender, resolveEndpoint } from '../request'
import { ETagManager } from '../etagManager'
import { BulkOperationHandler } from '../bulkOperations'
import { HTTPEventEmitter } from '../eventEmitter'
import { HTTPClient, ConflictHandler, ClientConfig } from '../client'
import { createOperationExecutors, OperationExecutors } from '../operationExecutors'
import type { QuerySerializerConfig } from '../query'
import type { QueuedOperation } from '../eventEmitter'
import { BatchEngine, Batch } from '#batch'
import { Observability } from '#observability'
import type { ObservabilityContext } from '#observability'
import { commitAtomMapUpdate } from '../../../core/store/cacheWriter'
import { validateWithSchema } from '../../../core/store/validation'
import type { StoreIndexes } from '../../../core/indexes/StoreIndexes'
import type { VNextChange, VNextJsonPatch, VNextWriteAction, VNextWriteItem } from '#protocol'
import { fetchWithRetry } from '../transport/retry'
import type { BatchQueryConfig, HTTPAdapterConfig } from '../config/types'
import { traceFromArgs } from '../transport/trace'
import { SyncEngine } from '../../../sync'
import { createOpsTransport } from '../transport/ops'
import { SYNC_SSE_EVENT_CHANGES } from '#protocol'
import { VNextCursorStore, VNextOutboxStore } from '../syncVnextStore'


type ParsedBatchConfig = {
    enabled: boolean
    endpoint?: string
    maxBatchSize?: number
    flushIntervalMs?: number
    devWarnings: boolean
}

/**
 * Queued operation for offline support
 */
/**
 * HTTP Adapter for RESTful APIs
 */
export class HTTPAdapter<T extends Entity> implements IAdapter<T> {
    public readonly name: string
    private readonly queueStorageKey: string
    private etagManager: ETagManager
    private bulkOps: BulkOperationHandler<T>
    private eventEmitter: HTTPEventEmitter
    private client: HTTPClient<T>
    private executors: OperationExecutors<T>
    private serializerConfig?: QuerySerializerConfig
    private batchEngine?: BatchEngine
    private resourceNameForBatch: string
    private usePatchForUpdate: boolean
    private storeAccess?: StoreAccess<T>
    private syncEngine?: SyncEngine
    private syncOutbox?: VNextOutboxStore

    constructor(private config: HTTPAdapterConfig<T>) {
        // Auto-generate endpoints from resourceName if not explicitly provided
        if (!config.endpoints) {
            if (!config.resourceName) {
                throw new Error(
                    '[HTTPAdapter] Either "resourceName" or "endpoints" must be provided.\n' +
                    'Use "resourceName" for auto-generated RESTful endpoints, or provide custom "endpoints".'
                )
            }

            // Normalize path: ensure it starts with /
            const basePath = config.resourceName.startsWith('/')
                ? config.resourceName
                : `/${config.resourceName}`

            // Auto-generate RESTful endpoints
            config.endpoints = {
                getOne: (id) => `${basePath}/${id}`,
                getAll: () => basePath,
                create: () => basePath,
                update: (id) => `${basePath}/${id}`,
                delete: (id) => `${basePath}/${id}`,
                patch: (id) => `${basePath}/${id}`,
                bulkCreate: () => `${basePath}/bulk`,
                bulkUpdate: () => `${basePath}/bulk`,
                bulkDelete: () => `${basePath}/bulk`,
                bulkDeleteQueryParam: {
                    path: () => basePath,
                    param: 'ids',
                    maxUrlLength: 1800
                }
            }
        }

        // At this point, endpoints is guaranteed to be defined
        const endpoints = config.endpoints!
        const batchConfig = this.parseBatchConfig(config.batch)
        this.resourceNameForBatch = this.normalizeResourceName(config.resourceName)
        this.usePatchForUpdate = config.usePatchForUpdate ?? false

        this.name = config.baseURL
        this.queueStorageKey = `atoma:httpQueue:${this.name}`
        this.etagManager = new ETagManager(config.version?.cacheSize ?? 1000)
        this.bulkOps = new BulkOperationHandler<T>(
            {
                bulkCreate: endpoints.bulkCreate,
                bulkUpdate: endpoints.bulkUpdate,
                bulkDelete: endpoints.bulkDelete,
                bulkDeleteQueryParam: endpoints.bulkDeleteQueryParam,
                fallback: config.bulk?.fallback ?? 'parallel',
                concurrency: config.concurrency?.bulk ?? 5,
                batchSize: config.bulk?.batchSize ?? Infinity
            },
            {
                put: (item, internalContext) => this.put(item.id, item, internalContext),
                delete: (key, internalContext) => this.delete(key, internalContext)
            }
        )
        const conflictHandler: ConflictHandler<T> = {
            handle: async (response, key, localValue, conflictBody, metadata) => {
                let serverData: any
                try {
                    serverData = conflictBody || await response.json()
                } catch {
                    // No body? try re-fetching
                    const getResponse = await this.fetchWithRetry(
                        makeUrl(this.config.baseURL, resolveEndpoint(endpoints.getOne!, key)),
                        { headers: await this.getHeaders() }
                    )
                    if (getResponse.ok) {
                        serverData = await getResponse.json()
                    }
                }
                const etag = this.etagManager.extractFromResponse(response)

                await resolveConflict<T>(
                    response,
                    key,
                    localValue,
                    {
                        resolution: this.config.conflict?.resolution ?? 'last-write-wins',
                        onConflict: this.config.conflict?.onConflict,
                        onResolved: config.events?.onConflictResolved,
                        version: this.config.version,
                        onEtagExtracted: (k, tag) => this.etagManager.set(k, tag)
                    },
                    (k, v) => this.client.put(k, v),
                    metadata,
                    serverData,
                    etag
                )
            }
        }

        this.client = new HTTPClient(
            this.config as ClientConfig,
            this.sender,
            this.etagManager,
            () => this.getHeaders(),
            conflictHandler
        )

        this.eventEmitter = new HTTPEventEmitter(config.events)
        this.serializerConfig = config.querySerializer

        this.executors = createOperationExecutors({
            config: this.config,
            client: this.client,
            bulkOps: this.bulkOps,
            etagManager: this.etagManager,
            fetchWithRetry: this.fetchWithRetry.bind(this),
            getHeaders: this.getHeaders.bind(this),
            onError: this.onError.bind(this)
        })

        if (batchConfig.enabled) {
            const endpointPath = batchConfig.endpoint ?? '/ops'
            const batchEndpoint = makeUrl(this.config.baseURL, endpointPath)
            this.batchEngine = Batch.create({
                endpoint: batchEndpoint,
                maxBatchSize: batchConfig.maxBatchSize,
                flushIntervalMs: batchConfig.flushIntervalMs,
                headers: this.getHeaders.bind(this),
                fetchFn: this.fetchWithRetry.bind(this),
                onError: (error, payload) => {
                    this.onError(error, 'batch')
                    if (typeof process !== 'undefined' && process?.env?.NODE_ENV === 'development') {
                        console.debug?.('[HTTPAdapter:batch] payload failed', payload)
                    }
                }
            })

            if (batchConfig.devWarnings && typeof process !== 'undefined' && process?.env?.NODE_ENV === 'development') {
                console.info(
                    `[Atoma] BatchQuery enabled for "${this.resourceNameForBatch}" → ${batchEndpoint}\n` +
                    'Ensure backend exposes the ops endpoint. Set `batch:false` to disable.'
                )
            }
        }

        const syncEnabled = this.config.sync?.enabled === true
        if (syncEnabled) {
            const outboxKey = `${this.queueStorageKey}:sync-vnext`
            this.syncOutbox = new VNextOutboxStore(
                outboxKey,
                {
                    onQueueChange: this.config.events?.onQueueChange,
                    onQueueFull: (dropped, max) => this.config.events?.onQueueFull?.(dropped as any, max)
                },
                this.config.offline?.maxQueueSize ?? 1000
            )

            const cursorKey = this.config.sync?.cursorKey ?? `atoma:sync:${this.config.baseURL}:vnext:cursor`
            const cursorStore = new VNextCursorStore(cursorKey)

            this.syncEngine = new SyncEngine({
                transport: this.createSyncTransportVNext(),
                outbox: this.syncOutbox,
                cursor: cursorStore,
                applier: {
                    applyChanges: (changes) => this.applyChangesFromSync(changes),
                    applyWriteAck: (ack) => this.applyWriteAckFromSync(ack),
                    applyWriteReject: (reject) => this.applyWriteRejectFromSync(reject)
                },
                maxPushItems: this.config.sync?.pullLimit ?? 50,
                pullLimit: this.config.sync?.pullLimit ?? 200,
                resources: [this.resourceNameForBatch],
                returning: true,
                subscribe: true,
                reconnectDelayMs: this.config.sync?.pollIntervalMs ?? 1000,
                onError: (error) => this.config.events?.onSyncError?.(error, { phase: 'sync' } as any)
            })
        }
    }

    dispose(): void {
        this.detachStoreAccess()
        // Clear ETag cache to free memory
        this.etagManager.clear()
        this.batchEngine?.dispose()
        this.syncEngine?.dispose()
    }

    attachStoreAccess(access: StoreAccess<T>) {
        this.storeAccess = access
        if (this.config.sync?.enabled === true && this.config.sync?.autoStart !== false) {
            void this.startSync()
        }
    }

    detachStoreAccess() {
        this.stopSync()
        this.storeAccess = undefined
    }

    async put(key: StoreKey, value: T, internalContext?: ObservabilityContext): Promise<void> {
        if (this.config.sync?.enabled === true) {
            const baseVersion = this.resolveLocalBaseVersion(key, value)
            const item: VNextWriteItem = {
                entityId: String(key),
                baseVersion,
                value,
                meta: { clientTimeMs: Date.now() }
            }
            await this.enqueueSyncWrite('update', [item])
            return
        }
        if (this.batchEngine) {
            try {
                const baseVersion = this.resolveLocalBaseVersion(key, value)
                return await this.batchEngine.enqueuePatch(
                    this.resourceNameForBatch,
                    {
                        id: key,
                        patches: [{ op: 'replace', path: [key], value }] as any,
                        baseVersion,
                        timestamp: Date.now()
                    },
                    internalContext
                )
            } catch (error) {
                this.onError(error as Error, 'put(batch)')
                throw error
            }
        }
        const baseVersion = this.resolveLocalBaseVersion(key, value)
        const payload = (value && typeof value === 'object')
            ? ({ ...(value as any), baseVersion } as any)
            : value
        await this.client.put(
            key,
            payload,
            undefined,
            internalContext
        )
    }

    async bulkPut(items: T[], internalContext?: ObservabilityContext): Promise<void> {
        if (this.config.sync?.enabled === true) {
            if (!items.length) return
            const writeItems: VNextWriteItem[] = items.map(item => ({
                entityId: String((item as any).id),
                baseVersion: this.resolveLocalBaseVersion((item as any).id, item),
                value: item,
                meta: { clientTimeMs: Date.now() }
            }))
            await this.enqueueSyncWrite('update', writeItems)
            return
        }
        if (!items.length) return
        await Promise.all(items.map(item => this.put((item as any).id, item, internalContext)))
    }

    async bulkCreate(items: T[], internalContext?: ObservabilityContext): Promise<T[] | void> {
        if (this.batchEngine) {
            const created = await Promise.all(items.map(item => {
                return this.batchEngine!.enqueueCreate(
                    this.resourceNameForBatch,
                    item,
                    internalContext
                )
            }))
            return created
        }

        if (this.config.endpoints!.bulkCreate) {
            return await this.client.bulkCreate(
                items,
                undefined,
                internalContext
            )
        }

        await this.executors.bulkPut(items, internalContext)
    }

    async delete(key: StoreKey, internalContext?: ObservabilityContext): Promise<void> {
        if (this.config.sync?.enabled === true) {
            const baseVersion = this.resolveLocalBaseVersion(key)
            const item: VNextWriteItem = {
                entityId: String(key),
                baseVersion,
                meta: { clientTimeMs: Date.now() }
            }
            await this.enqueueSyncWrite('delete', [item])
            return
        }
        if (this.batchEngine) {
            try {
                const baseVersion = this.resolveLocalBaseVersion(key)
                return await this.batchEngine.enqueueDelete(this.resourceNameForBatch, { id: key, baseVersion }, internalContext)
            } catch (error) {
                this.onError(error as Error, 'delete(batch)')
                throw error
            }
        }
        const baseVersion = this.resolveLocalBaseVersion(key)
        await this.client.delete(
            key,
            { baseVersion },
            undefined,
            internalContext
        )
    }

    async bulkDelete(keys: StoreKey[], internalContext?: ObservabilityContext): Promise<void> {
        if (this.config.sync?.enabled === true) {
            if (!keys.length) return
            const writeItems: VNextWriteItem[] = keys.map(key => ({
                entityId: String(key),
                baseVersion: this.resolveLocalBaseVersion(key),
                meta: { clientTimeMs: Date.now() }
            }))
            await this.enqueueSyncWrite('delete', writeItems)
            return
        }
        if (!keys.length) return
        await Promise.all(keys.map(k => this.delete(k, internalContext)))
    }

    async get(key: StoreKey, internalContext?: ObservabilityContext): Promise<T | undefined> {
        if (this.batchEngine) {
            const params: FindManyOptions<T> = {
                where: { id: key } as any,
                limit: 1,
                includeTotal: false
            }

            try {
                const result = await this.batchEngine.enqueueQuery(
                    this.resourceNameForBatch,
                    params,
                    () => this.executors.findMany(params, internalContext),
                    internalContext
                )

                return result.data[0]
            } catch (error) {
                this.onError(error as Error, 'get(batch-fallback)')
            }
        }

        return this.executors.get(key, internalContext)
    }

    async bulkGet(keys: StoreKey[], internalContext?: ObservabilityContext): Promise<(T | undefined)[]> {
        if (!keys.length) return []

        // 若启用 batch，则将 bulkGet 转为一次批量 query（where in），否则回退并发 GET
        if (this.batchEngine) {
            const uniqueKeys = Array.from(new Set(keys))
            const params: FindManyOptions<T> = { where: { id: { in: uniqueKeys } } as any, skipStore: false }

            try {
                const result = await this.batchEngine.enqueueQuery<T>(
                    this.resourceNameForBatch,
                    params,
                    () => this.executors.bulkGet(uniqueKeys, internalContext).then(list => list.filter((i): i is T => i !== undefined)),
                    internalContext
                )

                const data = result.data

                const map = new Map<StoreKey, T>()
                data.forEach(item => {
                    const id = (item as any)?.id
                    if (id !== undefined) map.set(id, item)
                })

                // 保持与输入 keys 相同的顺序与重复
                return keys.map(key => map.get(key))
            } catch (error) {
                // 失败时回退到原有并发 GET
                this.onError(error as Error, 'bulkGet(batch-fallback)')
            }
        }

        return this.executors.bulkGet(keys, internalContext)
    }

    async getAll(filter?: (item: T) => boolean, internalContext?: ObservabilityContext): Promise<T[]> {
        if (this.batchEngine) {
            try {
                const result = await this.batchEngine.enqueueQuery<T>(
                    this.resourceNameForBatch,
                    undefined,
                    () => this.executors.getAll(filter, internalContext),
                    internalContext
                )

                return filter ? result.data.filter(filter) : result.data
            } catch (error) {
                this.onError(error as Error, 'getAll(batch-fallback)')
            }
        }

        return this.executors.getAll(filter, internalContext)
    }

    async findMany(
        options?: FindManyOptions<T>,
        internalContext?: ObservabilityContext
    ): Promise<{ data: T[]; pageInfo?: PageInfo }> {
        if (this.batchEngine) {
            return this.batchEngine.enqueueQuery(
                this.resourceNameForBatch,
                options,
                () => this.executors.findMany(options, internalContext),
                internalContext
            )
        }
        return this.executors.findMany(options, internalContext)
    }

    async applyPatches(
        patches: Patch[],
        metadata: PatchMetadata,
        internalContext?: ObservabilityContext
    ): Promise<{ created?: T[] } | void> {
        if (this.config.sync?.enabled === true) {
            return this.applyPatchesViaSync(patches, metadata, internalContext)
        }
        const supportsPatch = !!this.config.endpoints!.patch
        const usePatchForUpdates = this.usePatchForUpdate && supportsPatch
        const nextTrace = () => traceFromArgs({ context: internalContext, traceId: metadata.traceId })

        const patchesByItemId = new Map<StoreKey, Patch[]>()
        patches.forEach(patch => {
            const itemId = patch.path[0] as StoreKey
            if (!patchesByItemId.has(itemId)) patchesByItemId.set(itemId, [])
            patchesByItemId.get(itemId)!.push(patch)
        })

        const tasks: Promise<any>[] = []
        const createdResults: T[] = []

        const handleCreate = (id: StoreKey, value: T) => {
            if (this.batchEngine) {
                tasks.push(this.batchEngine.enqueueCreate(
                    this.resourceNameForBatch,
                    value,
                    internalContext
                ).then((res: any) => {
                    if (res && typeof res === 'object' && (res as any).id !== undefined) {
                        createdResults.push(res as T)
                    }
                    return res
                }))
                return
            }
            const trace = nextTrace()
            tasks.push(this.client.create(
                id,
                value,
                trace.headers,
                trace.ctx
            ).then((res: any) => {
                if (res && typeof res === 'object' && (res as any).id !== undefined) {
                    createdResults.push(res as T)
                }
                return res
            }))
        }

        const handleDelete = (id: StoreKey) => {
            if (this.batchEngine) {
                const baseVersion = this.resolveLocalBaseVersion(id)
                tasks.push(
                    this.batchEngine.enqueueDelete(
                        this.resourceNameForBatch,
                        { id, baseVersion },
                        internalContext
                    )
                )
                return
            }
            const trace = nextTrace()
            const baseVersion = this.resolveLocalBaseVersion(id)
            tasks.push(this.client.delete(
                id,
                { baseVersion },
                trace.headers,
                trace.ctx
            ))
        }

        const handlePatch = (id: StoreKey, itemPatches: Patch[]) => {
            const baseVersion = this.resolveLocalBaseVersion(id)
            if (this.batchEngine) {
                tasks.push(
                    this.batchEngine.enqueuePatch(
                        this.resourceNameForBatch,
                        {
                            id,
                            patches: itemPatches,
                            baseVersion,
                            timestamp: metadata.timestamp
                        },
                        internalContext
                    )
                )
                return
            }
            const trace = nextTrace()
            tasks.push(this.client.patch(
                id,
                itemPatches,
                { ...metadata, baseVersion },
                trace.headers,
                trace.ctx
            ))
        }

        const handlePut = async (id: StoreKey, itemPatches: Patch[]) => {
            // 如果 patch 在根路径提供了完整值，直接用；否则需要当前值套 patch
            const rootReplace = itemPatches.find(p => (p.op === 'add' || p.op === 'replace') && p.path.length === 1)
            let next: any
            if (rootReplace) {
                next = rootReplace.value
            } else {
                const current = await this.executors.get(id, internalContext)
                if (current === undefined) throw new Error(`Item ${id} not found for put`)
                next = applyPatches(current as any, itemPatches)
            }

            if (this.batchEngine) {
                const baseVersion = this.resolveLocalBaseVersion(id, next)
                tasks.push(
                    this.batchEngine.enqueuePatch(
                        this.resourceNameForBatch,
                        {
                            id,
                            patches: [{ op: 'replace', path: [id], value: next }] as any,
                            baseVersion,
                            timestamp: metadata.timestamp ?? Date.now()
                        },
                        internalContext
                    )
                )
                return
            }

            const trace = nextTrace()
            const baseVersion = this.resolveLocalBaseVersion(id, next)
            const payload = (next && typeof next === 'object') ? ({ ...(next as any), baseVersion } as any) : next
            tasks.push(this.client.put(
                id,
                payload,
                trace.headers,
                trace.ctx
            ))
        }

        for (const [id, itemPatches] of patchesByItemId.entries()) {
            const isDelete = itemPatches.some(p => p.op === 'remove' && p.path.length === 1)
            if (isDelete) {
                handleDelete(id)
                continue
            }

            const rootAdd = itemPatches.find(p => p.op === 'add' && p.path.length === 1)
            const isCreate = Boolean(rootAdd)

            if (isCreate) {
                handleCreate(id, rootAdd!.value as T)
                continue
            }

            if (usePatchForUpdates) {
                handlePatch(id, itemPatches)
            } else {
                await handlePut(id, itemPatches)
            }
        }

        await Promise.all(tasks)

        if (createdResults.length) {
            return { created: createdResults }
        }
    }

    private async startSync() {
        if (!this.config.sync?.enabled) return
        if (!this.syncEngine) return
        this.syncEngine.start()
    }

    private stopSync() {
        if (!this.syncEngine) return
        this.syncEngine.stop()
    }

    private async enqueueSyncWrite(action: VNextWriteAction, items: VNextWriteItem[]) {
        if (!this.syncEngine) {
            throw new Error('[HTTPAdapter] syncEngine not initialized')
        }
        await this.syncEngine.enqueueWrite({
            resource: this.resourceNameForBatch,
            action,
            items
        })
    }

    private createSyncTransportVNext() {
        const baseURL = this.config.baseURL
        const opsEndpoint = this.config.sync?.endpoints?.ops ?? '/ops'
        const subscribeEndpoint = this.config.sync?.endpoints?.subscribeVNext ?? '/sync/subscribe-vnext'

        return {
            push: async (args: {
                opId: string
                resource: string
                action: VNextWriteAction
                items: VNextWriteItem[]
                options?: { returning?: boolean }
                meta: any
            }) => {
                const opsTransport = createOpsTransport({
                    fetchFn: this.fetchWithRetry.bind(this),
                    getHeaders: this.getHeaders.bind(this)
                })

                const writeOp = {
                    opId: args.opId,
                    kind: 'write' as const,
                    write: {
                        resource: args.resource,
                        action: args.action,
                        items: args.items,
                        options: args.options
                    }
                }

                const result = await opsTransport.executeOps({
                    url: baseURL,
                    endpoint: opsEndpoint,
                    ops: [writeOp],
                    clientTimeMs: args.meta.clientTimeMs
                })

                const writeResult = result.results[0]
                if (!writeResult || !writeResult.ok) {
                    throw new Error((writeResult as any)?.error?.message || 'Write operation failed')
                }

                return (writeResult as any).data
            },

            pull: async (args: {
                opId: string
                cursor: string
                limit: number
                resources?: string[]
                meta: any
            }) => {
                const opsTransport = createOpsTransport({
                    fetchFn: this.fetchWithRetry.bind(this),
                    getHeaders: this.getHeaders.bind(this)
                })

                const pullOp = {
                    opId: args.opId,
                    kind: 'changes.pull' as const,
                    pull: {
                        cursor: args.cursor,
                        limit: args.limit,
                        resources: args.resources
                    }
                }

                const result = await opsTransport.executeOps({
                    url: baseURL,
                    endpoint: opsEndpoint,
                    ops: [pullOp],
                    clientTimeMs: args.meta.clientTimeMs
                })

                const pullResult = result.results[0]
                if (!pullResult || !pullResult.ok) {
                    throw new Error((pullResult as any)?.error?.message || 'Pull operation failed')
                }

                return (pullResult as any).data
            },

            subscribe: (args: {
                cursor: string
                onBatch: (batch: any) => void
                onError: (error: unknown) => void
            }) => {
                const url = makeUrl(baseURL, subscribeEndpoint)
                const urlWithCursor = `${url}?cursor=${encodeURIComponent(args.cursor)}`

                let eventSource: EventSource

                const factory = this.config.sync?.sse?.eventSourceFactory
                if (factory) {
                    // Pass an object that matches the EventSourceFactory signature
                    eventSource = factory(urlWithCursor)
                } else if (typeof EventSource !== 'undefined') {
                    eventSource = new EventSource(urlWithCursor)
                } else {
                    throw new Error('[HTTPAdapter] EventSource not available and no factory provided')
                }

                eventSource.addEventListener(SYNC_SSE_EVENT_CHANGES, (event: any) => {
                    try {
                        const batch = JSON.parse(event.data)
                        args.onBatch(batch)
                    } catch (error) {
                        args.onError(error)
                    }
                })

                eventSource.onerror = (error) => {
                    args.onError(error)
                }

                return {
                    close: () => eventSource.close()
                }
            }
        }
    }

    private async applyChangesFromSync(changes: VNextChange[]) {
        if (!this.storeAccess) return

        const upsertIds = new Set<StoreKey>()
        const deleteIds = new Set<StoreKey>()

        for (const change of changes) {
            const id = change.entityId
            const key: StoreKey = (typeof id === 'string' && /^[0-9]+$/.test(id)) ? Number(id) : id

            if (change.kind === 'delete') {
                deleteIds.add(key)
            } else {
                upsertIds.add(key)
            }
        }

        if (!upsertIds.size && !deleteIds.size) return

        const fetched = upsertIds.size
            ? await this.bulkGet(Array.from(upsertIds))
            : []

        const items = fetched.filter((i): i is T => i !== undefined)
        await this.applyRemoteWriteback({ upserts: items, deletes: Array.from(deleteIds) })
    }

    private async applyWriteAckFromSync(ack: any) {
        if (!this.storeAccess) return

        const entityId = ack.result.entityId
        const version = ack.result.version

        if (typeof version !== 'number') return


        const key: StoreKey = (typeof entityId === 'string' && /^[0-9]+$/.test(entityId)) ? Number(entityId) : entityId

        // Update version in store
        const access = this.storeAccess
        const before = access.jotaiStore.get(access.atom)
        const cur = before.get(key) as any
        if (!cur || typeof cur !== 'object') return
        if (cur.version === version) return

        const after = new Map(before)
        after.set(key, { ...cur, version })
        commitAtomMapUpdate({
            jotaiStore: access.jotaiStore,
            atom: access.atom,
            before,
            after,
            context: access.context,
            indexes: (access.indexes as StoreIndexes<T>) ?? null
        })
    }

    private async applyWriteRejectFromSync(reject: any) {
        if (!this.storeAccess) return

        const error = reject.result.error
        const code = error?.code
        const current = reject.result.current

        if (code === 'CONFLICT' && current?.value) {
            const conflictStrategy = this.config.conflict?.resolution ?? 'last-write-wins'

            if (conflictStrategy === 'server-wins') {
                await this.applyRemoteWriteback({ upserts: [current.value], deletes: [] })
            }
        }
    }

    private async applyRemoteWriteback(args: { upserts: T[]; deletes: StoreKey[] }) {
        const access = this.storeAccess
        if (!access) return

        const before = access.jotaiStore.get(access.atom)
        const after = new Map(before)
        let changed = false

        args.deletes.forEach(id => {
            if (after.has(id)) {
                after.delete(id)
                changed = true
            }
        })

        const preserveReference = (incoming: T): T => {
            const existing = before.get((incoming as any).id)
            if (!existing) return incoming
            const keys = new Set([...Object.keys(existing as any), ...Object.keys(incoming as any)])
            for (const key of keys) {
                if ((existing as any)[key] !== (incoming as any)[key]) {
                    return incoming
                }
            }
            return existing
        }

        for (const raw of args.upserts) {
            const transformed = access.transform ? access.transform(raw) : raw
            const validated = await validateWithSchema(transformed, access.schema as any)
            const item = preserveReference(validated)
            const id = (item as any).id
            const prev = before.get(id)
            if (prev !== item) changed = true
            after.set((item as any).id, item)
        }

        if (!changed) return
        commitAtomMapUpdate({
            jotaiStore: access.jotaiStore,
            atom: access.atom,
            before,
            after,
            context: access.context,
            indexes: (access.indexes as StoreIndexes<T>) ?? null
        })
    }

    private resolveLocalBaseVersion(id: StoreKey, value?: any): number {
        const versionFromValue = value && typeof value === 'object' ? (value as any).version : undefined
        if (typeof versionFromValue === 'number' && Number.isFinite(versionFromValue)) return versionFromValue
        const fromStore = this.storeAccess?.jotaiStore.get(this.storeAccess.atom).get(id) as any
        const v = fromStore?.version
        if (typeof v === 'number' && Number.isFinite(v)) return v
        return 0
    }



    /**
     * Convert Immer patch path (array) to JSON Patch path (string)
     * Example: ['items', 0, 'name'] => '/items/0/name'
     */
    private immerPathToJsonPath(path: any[]): string {
        if (!path.length) return ''
        return '/' + path.map(segment => {
            // Escape special JSON Pointer characters
            return String(segment).replace(/~/g, '~0').replace(/\//g, '~1')
        }).join('/')
    }

    /**
     * Convert Immer patches to VNext JSON Patches
     * Strips the root entity ID from paths (first segment)
     */
    private convertImmerPatchesToVNext(patches: Patch[], entityId: StoreKey): VNextJsonPatch[] {
        return patches.map(p => {
            // Strip the entity ID from the path (first segment)
            const pathArray = Array.isArray((p as any).path) ? (p as any).path : []
            const adjustedPath = pathArray.length > 0 && pathArray[0] === entityId
                ? pathArray.slice(1)
                : pathArray

            const vnextPatch: VNextJsonPatch = {
                op: p.op as any,
                path: this.immerPathToJsonPath(adjustedPath)
            }

            if ('value' in p) {
                vnextPatch.value = (p as any).value
            }

            return vnextPatch
        })
    }

    private async applyPatchesViaSync(
        patches: Patch[],
        metadata: PatchMetadata,
        internalContext?: ObservabilityContext
    ): Promise<{ created?: T[] } | void> {
        if (!this.syncEngine) {
            throw new Error('[HTTPAdapter] syncEngine not initialized')
        }

        const patchesByItemId = new Map<StoreKey, Patch[]>()
        patches.forEach(patch => {
            const itemId = patch.path[0] as StoreKey
            if (!patchesByItemId.has(itemId)) patchesByItemId.set(itemId, [])
            patchesByItemId.get(itemId)!.push(patch)
        })

        const createItems: VNextWriteItem[] = []
        const updateItems: VNextWriteItem[] = []
        const patchItems: VNextWriteItem[] = []
        const deleteItems: VNextWriteItem[] = []
        const createItemIds: StoreKey[] = []

        for (const [id, itemPatches] of patchesByItemId.entries()) {
            // Check for delete
            const isDelete = itemPatches.some(p => p.op === 'remove' && p.path.length === 1)
            if (isDelete) {
                const baseVersion = this.resolveLocalBaseVersion(id)
                deleteItems.push({
                    entityId: String(id),
                    baseVersion,
                    meta: { clientTimeMs: metadata.timestamp ?? Date.now() }
                })
                continue
            }

            // Check for create
            const rootAdd = itemPatches.find(p => p.op === 'add' && p.path.length === 1)
            if (rootAdd) {
                createItems.push({
                    entityId: String(id),
                    value: rootAdd.value,
                    meta: { clientTimeMs: metadata.timestamp ?? Date.now() }
                })
                createItemIds.push(id)
                continue
            }

            // Check if this is a simple root replace (entire value replacement)
            const rootReplace = itemPatches.find(p => (p.op === 'add' || p.op === 'replace') && p.path.length === 1)
            if (rootReplace) {
                const baseVersion = this.resolveLocalBaseVersion(id, rootReplace.value)
                updateItems.push({
                    entityId: String(id),
                    baseVersion,
                    value: rootReplace.value,
                    meta: { clientTimeMs: metadata.timestamp ?? Date.now() }
                })
                continue
            }

            // Otherwise, use patch action for granular updates
            const baseVersion = this.resolveLocalBaseVersion(id)
            const vnextPatches = this.convertImmerPatchesToVNext(itemPatches, id)
            patchItems.push({
                entityId: String(id),
                baseVersion,
                patch: vnextPatches,
                meta: { clientTimeMs: metadata.timestamp ?? Date.now() }
            })
        }

        // Enqueue all write operations
        const writePromises: Promise<any>[] = []

        if (createItems.length) {
            writePromises.push(this.enqueueSyncWrite('create', createItems))
        }
        if (updateItems.length) {
            writePromises.push(this.enqueueSyncWrite('update', updateItems))
        }
        if (patchItems.length) {
            writePromises.push(this.enqueueSyncWrite('patch', patchItems))
        }
        if (deleteItems.length) {
            writePromises.push(this.enqueueSyncWrite('delete', deleteItems))
        }

        await Promise.all(writePromises)

        // For create operations, fetch the final state to get server-assigned IDs
        if (createItemIds.length) {
            // Wait a bit for the server to process (this is a simplification)
            // In a real implementation, you'd listen to the ack callback
            await new Promise(resolve => setTimeout(resolve, 100))

            const fetched = await this.executors.bulkGet(createItemIds as any)
            const created = fetched.filter((i): i is T => i !== undefined)
            return created.length ? { created } : undefined
        }
    }



    async onConnect(): Promise<void> {
        // HTTP connects on-demand, nothing to do
    }

    onDisconnect(): void {
        // HTTP disconnects automatically
    }

    onError(error: Error, operation: string): void {
        console.error(`[HTTPAdapter:${this.name}] Error in ${operation}:`, error)
    }

    /**
     * Fetch with retry logic
     */
    private async fetchWithRetry(
        input: RequestInfo | URL,
        init?: RequestInit
    ): Promise<Response> {
        return fetchWithRetry(fetch, input, init, this.config.retry)
    }

    /**
     * Get headers (supports async for auth tokens)
     */
    private async getHeaders(): Promise<Record<string, string>> {
        if (!this.config.headers) {
            return {}
        }

        const headers = this.config.headers()
        return headers instanceof Promise ? await headers : headers
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

    private resolveClientVersion(key: StoreKey, value: T): any {
        const versionField = this.config.version?.field
        if (versionField && value && typeof value === 'object' && (value as any)[versionField] !== undefined) {
            return (value as any)[versionField]
        }
        return this.etagManager.get(key)
    }

    /**
     * Lightweight sender wrapper to satisfy RequestSender signature
     */
    private readonly sender = (url: RequestInfo | URL, init?: RequestInit) => this.fetchWithRetry(url, init ?? {})
}
