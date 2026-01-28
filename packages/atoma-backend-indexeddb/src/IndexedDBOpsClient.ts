import type { Table } from 'dexie'
import { executeLocalQuery } from 'atoma/core'
import type {
    ChangeBatch,
    Operation,
    OperationResult,
    Query,
    QueryResultData,
    StandardError,
    WriteAction,
    WriteItem,
    WriteOptions,
    WriteResultData
} from 'atoma/protocol'
import type { ExecuteOpsInput, ExecuteOpsOutput, OpsClientLike } from 'atoma/backend'
import { zod } from 'atoma/shared'

const { parseOrThrow, z } = zod

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

function normalizeQuery(params: unknown): Query | undefined {
    if (!isPlainObject(params)) return undefined
    return params as Query
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

export class IndexedDBOpsClient implements OpsClientLike {
    constructor(private readonly config: {
        tableForResource: (resource: string) => Table<any, string>
    }) {
        this.config = parseOrThrow(
            z.object({ tableForResource: z.any() })
                .loose()
                .superRefine((value: any, ctx) => {
                    if (typeof value.tableForResource !== 'function') {
                        ctx.addIssue({ code: 'custom', message: '[IndexedDBOpsClient] config.tableForResource is required' })
                    }
                }),
            config,
            { prefix: '' }
        ) as any
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
                const query = normalizeQuery((op as any).query?.query)
                if (typeof resource !== 'string' || !resource) {
                    return { opId, ok: false, error: standardError({ code: 'INVALID_REQUEST', message: 'Missing query.resource', kind: 'validation' }) }
                }
                if (!query) {
                    return { opId, ok: false, error: standardError({ code: 'INVALID_REQUEST', message: 'Missing query.query', kind: 'validation' }) }
                }
                const data = await this.executeQuery(resource, query)
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

    private async executeQuery(resource: string, query: Query): Promise<QueryResultData> {
        const table = this.config.tableForResource(resource)
        const raw = await table.toArray()
        const items = raw
        const result = executeLocalQuery(items as any, query as any)
        return {
            data: result.data,
            ...(result.pageInfo ? { pageInfo: result.pageInfo } : {})
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
                    const key = id
                    const existing = await table.get(key as any)
                    const current = existing ?? undefined
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
                    const key = id
                    const existing = await table.get(key as any)
                    const current = existing ?? undefined
                    if (!current) {
                        results[index] = { index, ok: false, error: standardError({ code: 'NOT_FOUND', message: 'Not found', kind: 'not_found', details: { resource, entityId: id } }) }
                        continue
                    }

                    const baseVersion = raw?.baseVersion
                    const currentVersion = (current as any)?.version
                    if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                        results[index] = { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing baseVersion for update', kind: 'validation', details: { resource, entityId: id } }) }
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

                    const value = raw?.value
                    const next = isPlainObject(value) ? { ...(value as any) } : value
                    const nextVersion = baseVersion + 1
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
                    const key = id
                    const existing = await table.get(key as any)
                    const current = existing ?? undefined

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
                const key = id
                const existing = await table.get(key as any)
                const current = existing ?? undefined
                if (!current) {
                    results[index] = { index, ok: false, error: standardError({ code: 'NOT_FOUND', message: 'Not found', kind: 'not_found', details: { resource, entityId: id } }) }
                    continue
                }
                const baseVersion = raw?.baseVersion
                const currentVersion = (current as any)?.version
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                    results[index] = { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing baseVersion for delete', kind: 'validation', details: { resource, entityId: id } }) }
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
                const nextVersion = baseVersion + 1
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
}
