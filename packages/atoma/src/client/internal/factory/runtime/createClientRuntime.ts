import type { Entity, JotaiStore, OpsClientLike, Persistence, PersistRequest, PersistResult, RuntimeIo, StoreDataProcessor, WriteStrategy } from '#core'
import { Core, MutationPipeline } from '#core'
import { executeWriteOps } from '#core/mutation/pipeline/WriteOps'
import { createRuntimeIo } from '#core/runtime'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import type { EntityId, QueryParams, WriteAction } from '#protocol'
import type { StoreHandle } from '#core/store/internals/handleTypes'
import type { AtomaSchema } from '#client/types'
import type { ClientRuntimeInternal } from '#client/internal/types'
import { DataProcessor } from '#core/store/internals/dataProcessor'
import { ClientRuntimeObservability } from '#client/internal/factory/runtime/ClientRuntimeObservability'
import { ClientRuntimeStores } from '#client/internal/factory/runtime/ClientRuntimeStores'
import type { PersistHandler } from '#client/types/plugin'
import { ClientRuntimeInternalEngine } from '#client/internal/factory/runtime/ClientRuntimeInternalEngine'
import { Protocol } from '#protocol'
import { version } from '#shared'

export class ClientRuntime implements ClientRuntimeInternal {
    readonly clientId: string
    readonly ownerClient?: () => unknown
    readonly handles: Map<string, StoreHandle<any>>
    readonly toStoreKey: (storeName: import('#core').StoreToken) => string
    readonly opsClient: OpsClientLike
    readonly io: ClientRuntimeInternal['io']
    readonly mutation: MutationPipeline
    readonly dataProcessor: DataProcessor
    readonly jotaiStore: JotaiStore
    readonly stores: ClientRuntimeInternal['stores']
    readonly observability: ClientRuntimeInternal['observability']
    readonly persistence: Persistence
    readonly persistenceRouter: PersistenceRouter
    readonly internal: ClientRuntimeInternal['internal']

    constructor(args: {
        schema: AtomaSchema<any>
        opsClient: OpsClientLike
        dataProcessor?: StoreDataProcessor<any>
        defaults?: {
            idGenerator?: () => EntityId
        }
        mirrorWritebackToStore?: boolean
        localOnly?: boolean
        ownerClient?: () => unknown
    }) {
        // Internal stable id for namespacing store handles within this runtime instance.
        // Note: Use protocol ids (uuid when available) to avoid collisions.
        this.clientId = Protocol.ids.createOpId('client')
        this.ownerClient = args.ownerClient
        this.handles = new Map<string, StoreHandle<any>>()
        this.toStoreKey = (storeName) => `${this.clientId}:${String(storeName)}`

        this.opsClient = args.opsClient
        this.jotaiStore = createJotaiStore()
        this.dataProcessor = new DataProcessor(() => this)
        this.observability = new ClientRuntimeObservability()
        this.io = args.localOnly
            ? createLocalRuntimeIo(() => this as any)
            : createRuntimeIo(() => this as any)
        this.persistenceRouter = createClientRuntimePersistenceRouter(() => this, { localOnly: args.localOnly })
        this.persistence = this.persistenceRouter
        this.mutation = new MutationPipeline(this)
        this.stores = new ClientRuntimeStores(this, {
            schema: args.schema,
            dataProcessor: args.dataProcessor,
            defaults: args.defaults,
            ownerClient: args.ownerClient
        })

        this.internal = new ClientRuntimeInternalEngine(this, {
            mirrorWritebackToStore: args.mirrorWritebackToStore
        })
    }
}

class PersistenceRouter implements Persistence {
    private handlers = new Map<WriteStrategy, PersistHandler>()

    constructor(
        private readonly direct: <T extends Entity>(req: PersistRequest<T>) => Promise<PersistResult<T>>
    ) {}

    register = (key: WriteStrategy, handler: PersistHandler) => {
        const k = String(key)
        if (!k) throw new Error('[Atoma] persistence.register: key 必填')
        if (this.handlers.has(k)) throw new Error(`[Atoma] persistence.register: key 已存在: ${k}`)
        this.handlers.set(k, handler)
        return () => {
            this.handlers.delete(k)
        }
    }

    persist = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        const key = req.writeStrategy
        if (!key || key === 'direct') {
            return await this.direct(req)
        }
        const handler = this.handlers.get(key)
        if (!handler) {
            throw new Error(`[Atoma] persistence: 未注册 writeStrategy="${String(key)}"`)
        }
        return await handler({ req, next: this.direct })
    }
}

function createClientRuntimePersistenceRouter(
    runtime: () => ClientRuntimeInternal,
    opts?: { localOnly?: boolean }
): PersistenceRouter {
    const persistDirect = async <T extends Entity>(req: PersistRequest<T>): Promise<PersistResult<T>> => {
        if (opts?.localOnly) {
            return persistLocalOnly(req)
        }
        const normalized = await executeWriteOps<T>({
            clientRuntime: runtime() as any,
            handle: req.handle as any,
            ops: req.writeOps as any,
            context: req.context
        })
        return {
            status: 'confirmed',
            ...(normalized.created ? { created: normalized.created } : {}),
            ...(normalized.writeback ? { writeback: normalized.writeback } : {})
        }
    }

    return new PersistenceRouter(persistDirect)
}

function createLocalRuntimeIo(_runtime: () => ClientRuntimeInternal) {
    const executeOps: RuntimeIo['executeOps'] = async () => {
        throw new Error('[Atoma] local-only 模式不支持 ops 执行')
    }

    const query: RuntimeIo['query'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        params: QueryParams
    ) => {
        const map = handle.jotaiStore.get(handle.atom) as Map<EntityId, T>
        const items = Array.from(map.values()) as T[]

        const where = isPlainObject(params?.where) && Object.keys(params.where as any).length
            ? (params.where as any)
            : undefined

        const orderBy = Array.isArray(params?.orderBy)
            ? params.orderBy
            : (params?.orderBy ? [params.orderBy] : [])

        const normalizedOrderBy = orderBy.length
            ? orderBy
            : [{ field: 'id', direction: 'asc' as const }]

        const sorted = Core.query.applyQuery(items as any, {
            where,
            orderBy: normalizedOrderBy as any
        } as any) as any[]

        const fields = normalizeFields((params as any).fields)
        const select = selectFromFields(fields)

        const beforeToken = (typeof (params as any).before === 'string' && (params as any).before)
            ? (params as any).before as string
            : undefined
        const afterToken = (typeof (params as any).after === 'string' && (params as any).after)
            ? (params as any).after as string
            : undefined
        const wantsCursorPaging = Boolean(beforeToken || afterToken)

        if (!wantsCursorPaging) {
            const offset = normalizeOffset((params as any).offset) ?? 0
            const includeTotal = (typeof (params as any).includeTotal === 'boolean')
                ? (params as any).includeTotal as boolean
                : true
            const limit = normalizeOptionalLimit((params as any).limit)

            const slice = typeof limit === 'number'
                ? sorted.slice(offset, offset + limit)
                : sorted.slice(offset)

            const last = slice[slice.length - 1]
            const hasNext = typeof limit === 'number' ? (offset + limit < sorted.length) : false

            return {
                data: slice.map(i => projectSelect(i, select)) as any[],
                pageInfo: {
                    cursor: last && (last as any)?.id !== undefined ? String((last as any).id) : undefined,
                    hasNext,
                    ...(includeTotal ? { total: sorted.length } : {})
                }
            }
        }

        const limit = normalizeOptionalLimit((params as any).limit) ?? 50

        if (beforeToken) {
            const idx = sorted.findIndex(item => String((item as any)?.id) === beforeToken)
            const end = idx >= 0 ? idx : sorted.length
            const start = Math.max(0, end - limit)
            const slice = sorted.slice(start, end)
            const last = slice[slice.length - 1]
            const hasNext = start > 0
            return {
                data: slice.map(i => projectSelect(i, select)) as any[],
                pageInfo: {
                    cursor: last && (last as any)?.id !== undefined ? String((last as any).id) : beforeToken,
                    hasNext
                }
            }
        }

        if (afterToken) {
            const idx = sorted.findIndex(item => String((item as any)?.id) === afterToken)
            const start = idx >= 0 ? idx + 1 : 0
            const slice = sorted.slice(start, start + limit)
            const last = slice[slice.length - 1]
            const hasNext = start + limit < sorted.length
            return {
                data: slice.map(i => projectSelect(i, select)) as any[],
                pageInfo: {
                    cursor: last && (last as any)?.id !== undefined ? String((last as any).id) : afterToken,
                    hasNext
                }
            }
        }

        const slice = sorted.slice(0, limit)
        const last = slice[slice.length - 1]
        const hasNext = limit < sorted.length
        return {
            data: slice.map(i => projectSelect(i, select)) as any[],
            pageInfo: {
                cursor: last && (last as any)?.id !== undefined ? String((last as any).id) : undefined,
                hasNext
            }
        }
    }

    const write: RuntimeIo['write'] = async () => {
        throw new Error('[Atoma] local-only 模式不支持 io.write')
    }

    return { executeOps, query, write }
}

function persistLocalOnly<T extends Entity>(req: PersistRequest<T>): PersistResult<T> {
    const versionUpdates: Array<{ key: EntityId; version: number }> = []
    const map = req.handle.jotaiStore.get(req.handle.atom) as Map<EntityId, T>

    for (const entry of req.writeOps) {
        const op = entry.op as any
        if (!op || op.kind !== 'write') continue

        const write = op.write as { action: WriteAction; items: any[]; options?: any }
        const items = Array.isArray(write?.items) ? write.items : []
        const options = write?.options as { upsert?: { mode?: 'strict' | 'loose' } } | undefined
        const action = entry.action
        const upsertMode = options?.upsert?.mode === 'loose' ? 'loose' : 'strict'

        for (const item of items) {
            const entityId = resolveEntityId(item)
            if (!entityId) {
                throw new Error('[Atoma] local persistence: 缺少 entityId')
            }

            if (action === 'create') {
                const value = (item as any)?.value
                const nextVersion = version.resolvePositiveVersion(value) ?? 1
                versionUpdates.push({ key: entityId, version: nextVersion })
                continue
            }

            if (action === 'update') {
                const baseVersion = (item as any)?.baseVersion
                if (!isPositiveVersion(baseVersion)) {
                    throw new Error(`[Atoma] local persistence: update 缺少 baseVersion（id=${entityId})`)
                }
                const currentVersion = version.resolvePositiveVersion(map.get(entityId))
                if (typeof currentVersion === 'number' && currentVersion !== baseVersion) {
                    throw new Error(`[Atoma] local persistence: update 版本冲突（id=${entityId})`)
                }
                versionUpdates.push({ key: entityId, version: baseVersion + 1 })
                continue
            }

            if (action === 'upsert') {
                const baseVersion = (item as any)?.baseVersion
                if (upsertMode === 'strict' && isPositiveVersion(baseVersion) === false) {
                    const currentVersion = version.resolvePositiveVersion(map.get(entityId))
                    if (typeof currentVersion === 'number') {
                        throw new Error(`[Atoma] local persistence: strict upsert 缺少 baseVersion（id=${entityId})`)
                    }
                }
                const currentVersion = version.resolvePositiveVersion(map.get(entityId))
                const nextVersion = isPositiveVersion(baseVersion)
                    ? baseVersion + 1
                    : (typeof currentVersion === 'number' ? currentVersion + 1 : 1)
                versionUpdates.push({ key: entityId, version: nextVersion })
                continue
            }

            if (action === 'delete') {
                const baseVersion = (item as any)?.baseVersion
                if (!isPositiveVersion(baseVersion)) {
                    throw new Error(`[Atoma] local persistence: delete 缺少 baseVersion（id=${entityId})`)
                }
                const currentVersion = version.resolvePositiveVersion(map.get(entityId))
                if (typeof currentVersion === 'number' && currentVersion !== baseVersion) {
                    throw new Error(`[Atoma] local persistence: delete 版本冲突（id=${entityId})`)
                }
                versionUpdates.push({ key: entityId, version: baseVersion + 1 })
            }
        }
    }

    return {
        status: 'confirmed',
        ...(versionUpdates.length ? { writeback: { versionUpdates } } : {})
    }
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOptionalLimit(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return Math.max(0, Math.floor(value))
}

function normalizeOffset(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return Math.max(0, Math.floor(value))
}

function normalizeFields(fields: unknown): string[] | undefined {
    if (!Array.isArray(fields) || !fields.length) return undefined
    const out = fields.filter(f => typeof f === 'string' && f) as string[]
    return out.length ? out : undefined
}

function selectFromFields(fields: string[] | undefined): Record<string, boolean> | undefined {
    if (!fields?.length) return undefined
    const out: Record<string, boolean> = {}
    fields.forEach(f => { out[f] = true })
    return out
}

function projectSelect(data: unknown, select?: Record<string, boolean>): unknown {
    if (!select) return data
    if (!isPlainObject(data)) return data
    const out: Record<string, any> = {}
    Object.entries(select).forEach(([k, enabled]) => {
        if (!enabled) return
        if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = (data as any)[k]
    })
    return out
}

function resolveEntityId(item: unknown): string {
    if (!item || typeof item !== 'object') return ''
    const raw = (item as any).entityId
    if (typeof raw === 'string' && raw) return raw
    const value = (item as any).value
    if (value && typeof value === 'object') {
        const id = (value as any).id
        if (typeof id === 'string' && id) return id
    }
    return ''
}

function isPositiveVersion(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}
