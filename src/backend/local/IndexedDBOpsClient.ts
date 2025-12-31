import type { Table } from 'dexie'
import type { StoreKey } from '#core'
import type {
    ChangeBatch,
    Operation,
    OperationResult,
    QueryParams,
    QueryResultData,
    StandardError,
    WriteAction,
    WriteItem,
    WriteOptions,
    WriteResultData
} from '#protocol'
import type { ExecuteOpsInput, ExecuteOpsOutput } from '../OpsClient'
import { OpsClient } from '../OpsClient'
import { QueryMatcher } from '../../core/query/QueryMatcher'

type TransformData = (args: { resource: string; data: any }) => any | undefined

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toStoreKey(entityId: string): StoreKey {
    if (entityId.match(/^[0-9]+$/)) return Number(entityId)
    return entityId
}

function standardError(args: { code: string; message: string; kind: StandardError['kind']; details?: StandardError['details'] }): StandardError {
    return {
        code: args.code,
        message: args.message,
        kind: args.kind,
        ...(args.details !== undefined ? { details: args.details } : {})
    }
}

function compareBy(rules: Array<{ field: string; direction: 'asc' | 'desc' }>) {
    return (a: any, b: any) => {
        for (const rule of rules) {
            const av = a?.[rule.field]
            const bv = b?.[rule.field]
            if (av === bv) continue
            if (av === undefined || av === null) return 1
            if (bv === undefined || bv === null) return -1
            if (av > bv) return rule.direction === 'desc' ? -1 : 1
            if (av < bv) return rule.direction === 'desc' ? 1 : -1
        }
        return 0
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

function clonePlain(value: any) {
    return value ? JSON.parse(JSON.stringify(value)) : value
}

function serializeValue(value: any) {
    const cloned = isPlainObject(value) ? { ...value } : value

    const iterate = (obj: any) => {
        const stack = [obj]
        while (stack.length > 0) {
            const currentObj = stack.pop()
            if (!currentObj || typeof currentObj !== 'object') continue

            Object.keys(currentObj).forEach(key => {
                if (currentObj[key] instanceof Map) {
                    currentObj[key] = Array.from(currentObj[key].values())
                } else if (currentObj[key] instanceof Set) {
                    currentObj[key] = Array.from(currentObj[key])
                } else if (typeof currentObj[key] === 'object' && currentObj[key] !== null) {
                    stack.push(currentObj[key])
                }
            })
        }
    }

    iterate(cloned)
    return cloned
}

export class IndexedDBOpsClient extends OpsClient {
    constructor(private readonly config: {
        tableForResource: (resource: string) => Table<any, StoreKey>
        transformData?: TransformData
    }) {
        super()
        if (!config?.tableForResource || typeof config.tableForResource !== 'function') {
            throw new Error('[IndexedDBOpsClient] config.tableForResource is required')
        }
    }

    async executeOps(input: ExecuteOpsInput): Promise<ExecuteOpsOutput> {
        const ops = Array.isArray(input.ops) ? input.ops : []
        const results: OperationResult[] = []
        for (const op of ops) {
            results.push(await this.executeSingleOp(op))
        }
        return { results }
    }

    private async executeSingleOp(op: Operation): Promise<OperationResult> {
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
                const data = await this.executeQuery(resource, params)
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
                const data = await this.executeWrite(resource, action, items, options)
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

    private async executeQuery(resource: string, params: QueryParams): Promise<QueryResultData> {
        const table = this.config.tableForResource(resource)
        const raw = await table.toArray()
        const items = this.applyTransform(resource, raw)

        const where = params.where
        const filtered = (where && isPlainObject(where) && Object.keys(where).length)
            ? items.filter(item => QueryMatcher.matchesWhere(item, where))
            : items

        const orderBy = Array.isArray(params.orderBy) && params.orderBy.length
            ? params.orderBy
            : [{ field: 'id', direction: 'asc' as const }]
        const sorted = filtered.slice().sort(compareBy(orderBy))

        const select = params.select
        const page = params.page
        if (!page) {
            return { items: sorted.map(i => projectSelect(i, select)) }
        }

        if (page.mode === 'offset') {
            const limit = typeof page.limit === 'number' && Number.isFinite(page.limit) ? Math.max(0, Math.floor(page.limit)) : 0
            const offset = typeof page.offset === 'number' && Number.isFinite(page.offset) ? Math.max(0, Math.floor(page.offset)) : 0
            const slice = sorted.slice(offset, offset + limit)
            const last = slice[slice.length - 1]
            const hasNext = offset + limit < sorted.length
            const includeTotal = page.includeTotal !== false
            return {
                items: slice.map(i => projectSelect(i, select)),
                pageInfo: {
                    cursor: last && (last as any)?.id !== undefined ? String((last as any).id) : undefined,
                    hasNext,
                    ...(includeTotal ? { total: sorted.length } : {})
                }
            }
        }

        const limit = typeof page.limit === 'number' && Number.isFinite(page.limit) ? Math.max(0, Math.floor(page.limit)) : 0
        const after = typeof page.after === 'string' && page.after ? page.after : undefined
        const before = typeof page.before === 'string' && page.before ? page.before : undefined

        if (after) {
            const idx = sorted.findIndex(item => String((item as any)?.id) === after)
            const start = idx >= 0 ? idx + 1 : 0
            const slice = sorted.slice(start, start + limit)
            const last = slice[slice.length - 1]
            const hasNext = start + limit < sorted.length
            return {
                items: slice.map(i => projectSelect(i, select)),
                pageInfo: {
                    cursor: last && (last as any)?.id !== undefined ? String((last as any).id) : after,
                    hasNext
                }
            }
        }

        if (before) {
            const idx = sorted.findIndex(item => String((item as any)?.id) === before)
            const end = idx >= 0 ? idx : sorted.length
            const start = Math.max(0, end - limit)
            const slice = sorted.slice(start, end)
            const last = slice[slice.length - 1]
            const hasNext = start > 0
            return {
                items: slice.map(i => projectSelect(i, select)),
                pageInfo: {
                    cursor: last && (last as any)?.id !== undefined ? String((last as any).id) : before,
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

    private async executeWrite(resource: string, action: WriteAction, items: WriteItem[], options?: WriteOptions): Promise<WriteResultData> {
        const table = this.config.tableForResource(resource)
        const returning = options?.returning !== false
        const select = options?.select

        const merge = options?.merge !== false
        const upsertMode: 'strict' | 'loose' = options?.upsert?.mode === 'loose' ? 'loose' : 'strict'

        const results: any[] = new Array(items.length)

        for (let index = 0; index < items.length; index++) {
            const raw = items[index] as any
            try {
                if (action === 'create') {
                    const entityId = raw?.entityId
                    if (entityId === undefined || entityId === null || entityId === '') {
                        results[index] = { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing entityId for create', kind: 'validation', details: { resource } }) }
                        continue
                    }
                    const id = String(entityId)
                    const key = toStoreKey(id)
                    const existing = await table.get(key as any)
                    const current = existing ? this.applyTransformOne(resource, existing) : undefined
                    if (current) {
                        const currentVersion = (current as any)?.version
                        results[index] = {
                            index,
                            ok: false,
                            error: standardError({ code: 'CONFLICT', message: 'Already exists', kind: 'conflict', details: { resource, entityId: id, currentVersion } }),
                            current: { value: clonePlain(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                        }
                        continue
                    }

                    const value = raw?.value
                    const next = isPlainObject(value) ? { ...(value as any) } : value
                    if (isPlainObject(next)) {
                        next.id = key
                        if (!(typeof next.version === 'number' && Number.isFinite(next.version) && next.version >= 1)) {
                            next.version = 1
                        }
                    }
                    await table.put(serializeValue(next), key as any)
                    const version = isPlainObject(next) && typeof next.version === 'number' ? next.version : 1
                    results[index] = {
                        index,
                        ok: true,
                        entityId: id,
                        version,
                        ...(returning ? { data: projectSelect(clonePlain(next), select) } : {})
                    }
                    continue
                }

                if (action === 'update') {
                    const entityId = raw?.entityId
                    const id = String(entityId ?? '')
                    if (!id) {
                        results[index] = { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing entityId for update', kind: 'validation', details: { resource } }) }
                        continue
                    }
                    const key = toStoreKey(id)
                    const existing = await table.get(key as any)
                    const current = existing ? this.applyTransformOne(resource, existing) : undefined
                    if (!current) {
                        results[index] = { index, ok: false, error: standardError({ code: 'NOT_FOUND', message: 'Not found', kind: 'not_found', details: { resource, entityId: id } }) }
                        continue
                    }

                    const baseVersion = raw?.baseVersion
                    const currentVersion = (current as any)?.version
                    if (typeof baseVersion === 'number' && Number.isFinite(baseVersion)) {
                        if (typeof currentVersion !== 'number') {
                            results[index] = { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing version field', kind: 'validation', details: { resource } }) }
                            continue
                        }
                        if (currentVersion !== baseVersion) {
                            results[index] = {
                                index,
                                ok: false,
                                error: standardError({ code: 'CONFLICT', message: 'Version conflict', kind: 'conflict', details: { resource, entityId: id, currentVersion } }),
                                current: { value: clonePlain(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                            }
                            continue
                        }
                    }

                    const value = raw?.value
                    const next = isPlainObject(value) ? { ...(value as any) } : value
                    const nextVersion = (typeof baseVersion === 'number' && Number.isFinite(baseVersion))
                        ? baseVersion + 1
                        : (typeof currentVersion === 'number' && Number.isFinite(currentVersion) ? currentVersion + 1 : 1)
                    if (isPlainObject(next)) {
                        next.id = key
                        next.version = nextVersion
                    }
                    await table.put(serializeValue(next), key as any)
                    results[index] = {
                        index,
                        ok: true,
                        entityId: id,
                        version: nextVersion,
                        ...(returning ? { data: projectSelect(clonePlain(next), select) } : {})
                    }
                    continue
                }

                if (action === 'upsert') {
                    const entityId = raw?.entityId
                    const id = String(entityId ?? '')
                    if (!id) {
                        results[index] = { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing entityId for upsert', kind: 'validation', details: { resource } }) }
                        continue
                    }
                    const key = toStoreKey(id)
                    const existing = await table.get(key as any)
                    const current = existing ? this.applyTransformOne(resource, existing) : undefined

                    const baseVersion = raw?.baseVersion
                    const value = raw?.value
                    const candidate = isPlainObject(value) ? { ...(value as any) } : value

                    if (!current) {
                        const next = candidate
                        if (isPlainObject(next)) {
                            next.id = key
                            if (!(typeof next.version === 'number' && Number.isFinite(next.version) && next.version >= 1)) {
                                next.version = 1
                            }
                        }
                        await table.put(serializeValue(next), key as any)
                        const version = isPlainObject(next) && typeof next.version === 'number' ? next.version : 1
                        results[index] = {
                            index,
                            ok: true,
                            entityId: id,
                            version,
                            ...(returning ? { data: projectSelect(clonePlain(next), select) } : {})
                        }
                        continue
                    }

                    const currentVersion = (current as any)?.version
                    if (upsertMode === 'strict') {
                        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion))) {
                            results[index] = {
                                index,
                                ok: false,
                                error: standardError({
                                    code: 'CONFLICT',
                                    message: 'Strict upsert requires baseVersion for existing entity',
                                    kind: 'conflict',
                                    details: { resource, entityId: id, currentVersion, hint: 'rebase' }
                                }),
                                current: { value: clonePlain(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                            }
                            continue
                        }
                        if (typeof currentVersion !== 'number') {
                            results[index] = { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing version field', kind: 'validation', details: { resource } }) }
                            continue
                        }
                        if (currentVersion !== baseVersion) {
                            results[index] = {
                                index,
                                ok: false,
                                error: standardError({ code: 'CONFLICT', message: 'Version conflict', kind: 'conflict', details: { resource, entityId: id, currentVersion } }),
                                current: { value: clonePlain(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                            }
                            continue
                        }
                    }

                    const nextVersion = (typeof baseVersion === 'number' && Number.isFinite(baseVersion))
                        ? baseVersion + 1
                        : (typeof currentVersion === 'number' && Number.isFinite(currentVersion) ? currentVersion + 1 : 1)

                    const next = merge && isPlainObject(current) && isPlainObject(candidate)
                        ? { ...(current as any), ...(candidate as any) }
                        : candidate

                    if (isPlainObject(next)) {
                        next.id = key
                        next.version = nextVersion
                    }
                    await table.put(serializeValue(next), key as any)
                    results[index] = {
                        index,
                        ok: true,
                        entityId: id,
                        version: nextVersion,
                        ...(returning ? { data: projectSelect(clonePlain(next), select) } : {})
                    }
                    continue
                }

                // delete
                const entityId = raw?.entityId
                const id = String(entityId ?? '')
                if (!id) {
                    results[index] = { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing entityId for delete', kind: 'validation', details: { resource } }) }
                    continue
                }
                const key = toStoreKey(id)
                const existing = await table.get(key as any)
                const current = existing ? this.applyTransformOne(resource, existing) : undefined
                if (!current) {
                    results[index] = { index, ok: false, error: standardError({ code: 'NOT_FOUND', message: 'Not found', kind: 'not_found', details: { resource, entityId: id } }) }
                    continue
                }
                const baseVersion = raw?.baseVersion
                const currentVersion = (current as any)?.version
                if (typeof baseVersion === 'number' && Number.isFinite(baseVersion)) {
                    if (typeof currentVersion !== 'number') {
                        results[index] = { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing version field', kind: 'validation', details: { resource } }) }
                        continue
                    }
                    if (currentVersion !== baseVersion) {
                        results[index] = {
                            index,
                            ok: false,
                            error: standardError({ code: 'CONFLICT', message: 'Version conflict', kind: 'conflict', details: { resource, entityId: id, currentVersion } }),
                            current: { value: clonePlain(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                        }
                        continue
                    }
                }
                const nextVersion = (typeof baseVersion === 'number' && Number.isFinite(baseVersion))
                    ? baseVersion + 1
                    : (typeof currentVersion === 'number' && Number.isFinite(currentVersion) ? currentVersion + 1 : 1)
                await table.delete(key as any)
                results[index] = { index, ok: true, entityId: id, version: nextVersion }
            } catch (err: any) {
                results[index] = {
                    index,
                    ok: false,
                    error: standardError({ code: 'WRITE_FAILED', message: 'Write failed', kind: 'internal', details: { resource, cause: String(err?.message ?? err) } })
                }
            }
        }

        return { transactionApplied: false, results } as WriteResultData
    }

    private applyTransform(resource: string, list: any[]): any[] {
        const t = this.config.transformData
        if (!t) return list
        const out: any[] = []
        list.forEach((row) => {
            const next = t({ resource, data: row })
            if (next !== undefined) out.push(next)
        })
        return out
    }

    private applyTransformOne(resource: string, row: any): any | undefined {
        const t = this.config.transformData
        if (!t) return row
        return t({ resource, data: row })
    }
}
