import type { ExecuteOpsInput, ExecuteOpsOutput, OpsClientLike } from 'atoma/backend'
import type { ChangeBatch, Operation, OperationResult, QueryParams, QueryResultData, StandardError, WriteAction, WriteItem, WriteOptions, WriteResultData } from 'atoma/protocol'
import { Core } from 'atoma/core'

type ResourceStore = Map<string, any>

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function standardError(args: { code: string; message: string; kind: StandardError['kind']; details?: StandardError['details'] }): StandardError {
    return {
        code: args.code,
        message: args.message,
        kind: args.kind,
        ...(args.details !== undefined ? { details: args.details } : {})
    }
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

function normalizeWriteOptions(options: unknown): WriteOptions | undefined {
    if (!isPlainObject(options)) return undefined
    return options as WriteOptions
}

function normalizeQueryParams(params: unknown): QueryParams | undefined {
    if (!isPlainObject(params)) return undefined
    return params as QueryParams
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

export class MemoryOpsClient implements OpsClientLike {
    private readonly storesByResource = new Map<string, ResourceStore>()

    constructor(private readonly config?: {
        seed?: Record<string, any[]>
    }) {
        if (config?.seed && isPlainObject(config.seed)) {
            Object.entries(config.seed).forEach(([resource, items]) => {
                if (!Array.isArray(items)) return
                const store = this.requireStore(resource)
                items.forEach(item => {
                    const id = (item as any)?.id
                    if (id === undefined) return
                    const entityId = String(id)
                    const current = isPlainObject(item) ? { ...(item as any) } : item
                    if (isPlainObject(current)) {
                        current.id = entityId
                        if (!(typeof current.version === 'number' && Number.isFinite(current.version) && current.version >= 1)) {
                            current.version = 1
                        }
                    }
                    store.set(entityId, current)
                })
            })
        }
    }

    async executeOps(input: ExecuteOpsInput): Promise<ExecuteOpsOutput> {
        const ops = Array.isArray(input.ops) ? input.ops : []
        const results: OperationResult[] = ops.map(op => this.executeSingleOp(op))
        return { results }
    }

    private executeSingleOp(op: Operation): OperationResult {
        try {
            if (!op || typeof op !== 'object' || typeof (op as any).opId !== 'string') {
                return {
                    opId: (op as any)?.opId ?? '',
                    ok: false,
                    error: standardError({ code: 'INVALID_REQUEST', message: 'Missing opId', kind: 'validation' })
                }
            }
            const opId = (op as any).opId as string

            if (op.kind === 'query') {
                const resource = (op as any).query?.resource
                const params = normalizeQueryParams((op as any).query?.params)
                if (typeof resource !== 'string' || !resource) {
                    return { opId, ok: false, error: standardError({ code: 'INVALID_REQUEST', message: 'Missing query.resource', kind: 'validation' }) }
                }
                if (!params) {
                    return { opId, ok: false, error: standardError({ code: 'INVALID_REQUEST', message: 'Missing query.params', kind: 'validation' }) }
                }
                const data = this.executeQuery(resource, params)
                return { opId, ok: true, data }
            }

            if (op.kind === 'write') {
                const write = (op as any).write
                const resource = write?.resource
                const action = write?.action as WriteAction | undefined
                const items = Array.isArray(write?.items) ? (write.items as WriteItem[]) : undefined
                const options = normalizeWriteOptions(write?.options)
                if (typeof resource !== 'string' || !resource) {
                    return { opId, ok: false, error: standardError({ code: 'INVALID_REQUEST', message: 'Missing write.resource', kind: 'validation' }) }
                }
                if (action !== 'create' && action !== 'update' && action !== 'delete' && action !== 'upsert') {
                    return { opId, ok: false, error: standardError({ code: 'INVALID_REQUEST', message: 'Invalid write.action', kind: 'validation' }) }
                }
                if (!items) {
                    return { opId, ok: false, error: standardError({ code: 'INVALID_REQUEST', message: 'Missing write.items', kind: 'validation' }) }
                }
                const data = this.executeWrite(resource, action, items, options)
                return { opId, ok: true, data }
            }

            if (op.kind === 'changes.pull') {
                const cursor = (op as any).pull?.cursor
                const data: ChangeBatch = {
                    nextCursor: typeof cursor === 'string' ? cursor : '0',
                    changes: []
                }
                return { opId, ok: true, data }
            }

            return {
                opId,
                ok: false,
                error: standardError({ code: 'INVALID_REQUEST', message: `Unsupported op kind: ${(op as any).kind}`, kind: 'validation' })
            }
        } catch (err: any) {
            return {
                opId: (op as any)?.opId ?? '',
                ok: false,
                error: standardError({ code: 'INTERNAL', message: 'Internal error', kind: 'internal', details: { cause: String(err?.message ?? err) } })
            }
        }
    }

    private executeQuery(resource: string, params: QueryParams): QueryResultData {
        const store = this.requireStore(resource)
        const items = Array.from(store.values())

        const where = params.where
        const orderBy = Array.isArray(params.orderBy) && params.orderBy.length
            ? params.orderBy
            : (params.orderBy && typeof params.orderBy === 'object' ? [params.orderBy] : [])
        const normalizedOrderBy = orderBy.length ? orderBy : [{ field: 'id', direction: 'asc' as const }]
        const sorted = Core.query.applyQuery(items as any, {
            where: (where && isPlainObject(where) && Object.keys(where).length) ? (where as any) : undefined,
            orderBy: normalizedOrderBy as any
        } as any) as any[]

        const fields = normalizeFields((params as any).fields)
        const select = selectFromFields(fields)

        const beforeToken = (typeof (params as any).before === 'string' && (params as any).before) ? (params as any).before as string : undefined
        const afterToken = (typeof (params as any).after === 'string' && (params as any).after) ? (params as any).after as string : undefined
        const afterOrCursor = afterToken

        const wantsCursorPaging = Boolean(beforeToken || afterOrCursor)

        if (!wantsCursorPaging) {
            const offset = normalizeOffset((params as any).offset) ?? 0
            const includeTotal = (typeof (params as any).includeTotal === 'boolean') ? (params as any).includeTotal as boolean : true

            const limit = normalizeOptionalLimit((params as any).limit)
            const slice = typeof limit === 'number'
                ? sorted.slice(offset, offset + limit)
                : sorted.slice(offset)
            const last = slice[slice.length - 1]
            const hasNext = typeof limit === 'number' ? (offset + limit < sorted.length) : false
            return {
                items: slice.map(i => projectSelect(i, select)),
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
                items: slice.map(i => projectSelect(i, select)),
                pageInfo: {
                    cursor: last && (last as any)?.id !== undefined ? String((last as any).id) : beforeToken,
                    hasNext
                }
            }
        }

        if (afterOrCursor) {
            const idx = sorted.findIndex(item => String((item as any)?.id) === afterOrCursor)
            const start = idx >= 0 ? idx + 1 : 0
            const slice = sorted.slice(start, start + limit)
            const last = slice[slice.length - 1]
            const hasNext = start + limit < sorted.length
            return {
                items: slice.map(i => projectSelect(i, select)),
                pageInfo: {
                    cursor: last && (last as any)?.id !== undefined ? String((last as any).id) : afterOrCursor,
                    hasNext
                }
            }
        }

        const slice = sorted.slice(0, limit)
        const last = slice[slice.length - 1]
        const hasNext = limit < sorted.length
        return {
            items: slice.map(i => projectSelect(i, select)),
            pageInfo: {
                cursor: last && (last as any)?.id !== undefined ? String((last as any).id) : undefined,
                hasNext
            }
        }
    }

    private executeWrite(resource: string, action: WriteAction, items: WriteItem[], options?: WriteOptions): WriteResultData {
        const store = this.requireStore(resource)
        const returning = options?.returning !== false
        const select = options?.select

        const merge = options?.merge !== false
        const upsertMode: 'strict' | 'loose' = options?.upsert?.mode === 'loose' ? 'loose' : 'strict'

        const results = items.map((raw, index) => {
            try {
                if (action === 'create') {
                    const entityId = (raw as any)?.entityId
                    if (entityId === undefined || entityId === null || entityId === '') {
                        return {
                            index,
                            ok: false,
                            error: standardError({ code: 'INVALID_WRITE', message: 'Missing entityId for create', kind: 'validation', details: { resource } })
                        }
                    }
                    const id = String(entityId)
                    const existing = store.get(id)
                    if (existing) {
                        const currentVersion = (existing as any)?.version
                        return {
                            index,
                            ok: false,
                            error: standardError({
                                code: 'CONFLICT',
                                message: 'Already exists',
                                kind: 'conflict',
                                details: { resource, entityId: id, currentVersion }
                            }),
                            current: { value: existing, ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                        }
                    }
                    const value = (raw as any)?.value
                    const next = isPlainObject(value) ? { ...(value as any) } : value
                    if (isPlainObject(next)) {
                        next.id = id
                        if (!(typeof next.version === 'number' && Number.isFinite(next.version) && next.version >= 1)) {
                            next.version = 1
                        }
                    }
                    store.set(id, next)
                    const version = isPlainObject(next) && typeof next.version === 'number' ? next.version : 1
                    return {
                        index,
                        ok: true,
                        entityId: id,
                        version,
                        ...(returning ? { data: projectSelect(next, select) } : {})
                    }
                }

                if (action === 'update') {
                    const entityId = (raw as any)?.entityId
                    const id = String(entityId ?? '')
                    if (!id) {
                        return { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing entityId for update', kind: 'validation', details: { resource } }) }
                    }

                    const current = store.get(id)
                    if (!current) {
                        return {
                            index,
                            ok: false,
                            error: standardError({ code: 'NOT_FOUND', message: 'Not found', kind: 'not_found', details: { resource, entityId: id } })
                        }
                    }

                    const baseVersion = (raw as any)?.baseVersion
                    const currentVersion = (current as any)?.version
                    if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                        return { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing baseVersion for update', kind: 'validation', details: { resource, entityId: id } }) }
                    }
                    if (typeof currentVersion !== 'number') {
                        return { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing version field', kind: 'validation', details: { resource } }) }
                    }
                    if (currentVersion !== baseVersion) {
                        return {
                            index,
                            ok: false,
                            error: standardError({ code: 'CONFLICT', message: 'Version conflict', kind: 'conflict', details: { resource, entityId: id, currentVersion } }),
                            current: { value: current, ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                        }
                    }

                    const value = (raw as any)?.value
                    const next = isPlainObject(value) ? { ...(value as any) } : value
                    const nextVersion = baseVersion + 1
                    if (isPlainObject(next)) {
                        next.id = id
                        next.version = nextVersion
                    }
                    store.set(id, next)
                    return {
                        index,
                        ok: true,
                        entityId: id,
                        version: nextVersion,
                        ...(returning ? { data: projectSelect(next, select) } : {})
                    }
                }

                if (action === 'upsert') {
                    const entityId = (raw as any)?.entityId
                    const id = String(entityId ?? '')
                    if (!id) {
                        return { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing entityId for upsert', kind: 'validation', details: { resource } }) }
                    }

                    const baseVersion = (raw as any)?.baseVersion
                    const value = (raw as any)?.value
                    const candidate = isPlainObject(value) ? { ...(value as any) } : value

                    const current = store.get(id)
                    if (!current) {
                        const next = candidate
                        if (isPlainObject(next)) {
                            next.id = id
                            if (!(typeof next.version === 'number' && Number.isFinite(next.version) && next.version >= 1)) {
                                next.version = 1
                            }
                        }
                        store.set(id, next)
                        const version = isPlainObject(next) && typeof next.version === 'number' ? next.version : 1
                        return {
                            index,
                            ok: true,
                            entityId: id,
                            version,
                            ...(returning ? { data: projectSelect(next, select) } : {})
                        }
                    }

                    const currentVersion = (current as any)?.version
                    if (upsertMode === 'strict') {
                        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion))) {
                            return {
                                index,
                                ok: false,
                                error: standardError({
                                    code: 'CONFLICT',
                                    message: 'Strict upsert requires baseVersion for existing entity',
                                    kind: 'conflict',
                                    details: { resource, entityId: id, currentVersion, hint: 'rebase' }
                                }),
                                current: { value: current, ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                            }
                        }
                        if (typeof currentVersion !== 'number') {
                            return { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing version field', kind: 'validation', details: { resource } }) }
                        }
                        if (currentVersion !== baseVersion) {
                            return {
                                index,
                                ok: false,
                                error: standardError({ code: 'CONFLICT', message: 'Version conflict', kind: 'conflict', details: { resource, entityId: id, currentVersion } }),
                                current: { value: current, ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                            }
                        }
                    }

                    const nextVersion = (typeof baseVersion === 'number' && Number.isFinite(baseVersion))
                        ? baseVersion + 1
                        : (typeof currentVersion === 'number' && Number.isFinite(currentVersion) ? currentVersion + 1 : 1)

                    const next = merge && isPlainObject(current) && isPlainObject(candidate)
                        ? { ...(current as any), ...(candidate as any) }
                        : candidate

                    if (isPlainObject(next)) {
                        next.id = id
                        next.version = nextVersion
                    }
                    store.set(id, next)
                    return {
                        index,
                        ok: true,
                        entityId: id,
                        version: nextVersion,
                        ...(returning ? { data: projectSelect(next, select) } : {})
                    }
                }

                // delete
                const entityId = (raw as any)?.entityId
                const id = String(entityId ?? '')
                if (!id) {
                    return { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing entityId for delete', kind: 'validation', details: { resource } }) }
                }
                const current = store.get(id)
                if (!current) {
                    return {
                        index,
                        ok: false,
                        error: standardError({ code: 'NOT_FOUND', message: 'Not found', kind: 'not_found', details: { resource, entityId: id } })
                    }
                }
                const baseVersion = (raw as any)?.baseVersion
                const currentVersion = (current as any)?.version
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                    return { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing baseVersion for delete', kind: 'validation', details: { resource, entityId: id } }) }
                }
                if (typeof currentVersion !== 'number') {
                    return { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing version field', kind: 'validation', details: { resource } }) }
                }
                if (currentVersion !== baseVersion) {
                    return {
                        index,
                        ok: false,
                        error: standardError({ code: 'CONFLICT', message: 'Version conflict', kind: 'conflict', details: { resource, entityId: id, currentVersion } }),
                        current: { value: current, ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                    }
                }
                const nextVersion = baseVersion + 1
                store.delete(id)
                return {
                    index,
                    ok: true,
                    entityId: id,
                    version: nextVersion
                }
            } catch (err: any) {
                return {
                    index,
                    ok: false,
                    error: standardError({ code: 'WRITE_FAILED', message: 'Write failed', kind: 'internal', details: { resource, cause: String(err?.message ?? err) } })
                }
            }
        })

        return {
            transactionApplied: false,
            results
        } as WriteResultData
    }

    private requireStore(resource: string): ResourceStore {
        const key = String(resource || '')
        const existing = this.storesByResource.get(key)
        if (existing) return existing
        const next: ResourceStore = new Map()
        this.storesByResource.set(key, next)
        return next
    }
}

