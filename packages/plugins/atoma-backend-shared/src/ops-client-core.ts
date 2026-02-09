import { runQuery } from 'atoma-core/query'
import type { Entity, Query as CoreQuery } from 'atoma-types/core'
import type { ExecuteOpsInput, ExecuteOpsOutput, OpsClientLike } from 'atoma-types/client'
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
} from 'atoma-types/protocol'

type PlainRecord = Record<string, any>

export type OpsStorageAdapter = Readonly<{
    list: (resource: string) => Promise<any[]>
    get: (resource: string, id: string) => Promise<any | undefined>
    put: (resource: string, id: string, value: any) => Promise<void>
    delete: (resource: string, id: string) => Promise<void>
}>

export type StorageOpsClientOptions = Readonly<{
    adapter: OpsStorageAdapter
    toStoredValue?: (value: any) => any
    toResponseValue?: (value: any) => any
}>

function isPlainObject(value: unknown): value is PlainRecord {
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

    const out: PlainRecord = {}
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

export class StorageOpsClient implements OpsClientLike {
    private readonly adapter: OpsStorageAdapter
    private readonly toStoredValue: (value: any) => any
    private readonly toResponseValue: (value: any) => any

    constructor(options: StorageOpsClientOptions) {
        if (!options || typeof options !== 'object') {
            throw new Error('[Atoma] StorageOpsClient: options is required')
        }
        if (!options.adapter || typeof options.adapter !== 'object') {
            throw new Error('[Atoma] StorageOpsClient: options.adapter is required')
        }
        if (typeof options.adapter.list !== 'function'
            || typeof options.adapter.get !== 'function'
            || typeof options.adapter.put !== 'function'
            || typeof options.adapter.delete !== 'function') {
            throw new Error('[Atoma] StorageOpsClient: adapter methods list/get/put/delete are required')
        }

        this.adapter = options.adapter
        this.toStoredValue = options.toStoredValue ?? (value => value)
        this.toResponseValue = options.toResponseValue ?? (value => value)
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
        const items = await this.adapter.list(resource)
        const snapshot = new Map(items.map((item, index) => [String(index), item as Entity] as const))
        const result = runQuery({
            snapshot,
            query: query as CoreQuery<Entity>,
            indexes: null
        })
        return {
            data: result.data,
            ...(result.pageInfo ? { pageInfo: result.pageInfo } : {})
        }
    }

    private async executeWrite(resource: string, action: WriteAction, items: WriteItem[], options?: WriteOptions): Promise<WriteResultData> {
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
                    const current = await this.adapter.get(resource, id)
                    if (current) {
                        const currentVersion = (current as any)?.version
                        results[index] = {
                            index,
                            ok: false,
                            error: standardError({ code: 'CONFLICT', message: 'Already exists', kind: 'conflict', details: { resource, entityId: id, currentVersion } }),
                            current: { value: this.toResponseValue(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                        }
                        continue
                    }

                    const value = raw?.value
                    const next = isPlainObject(value) ? { ...(value as any) } : value
                    if (isPlainObject(next)) {
                        next.id = id
                        if (!(typeof next.version === 'number' && Number.isFinite(next.version) && next.version >= 1)) {
                            next.version = 1
                        }
                    }

                    await this.adapter.put(resource, id, this.toStoredValue(next))
                    const version = isPlainObject(next) && typeof next.version === 'number' ? next.version : 1
                    results[index] = {
                        index,
                        ok: true,
                        entityId: id,
                        version,
                        ...(returning ? { data: projectSelect(this.toResponseValue(next), select) } : {})
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

                    const current = await this.adapter.get(resource, id)
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
                            current: { value: this.toResponseValue(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                        }
                        continue
                    }

                    const value = raw?.value
                    const next = isPlainObject(value) ? { ...(value as any) } : value
                    const nextVersion = baseVersion + 1
                    if (isPlainObject(next)) {
                        next.id = id
                        next.version = nextVersion
                    }

                    await this.adapter.put(resource, id, this.toStoredValue(next))
                    results[index] = {
                        index,
                        ok: true,
                        entityId: id,
                        version: nextVersion,
                        ...(returning ? { data: projectSelect(this.toResponseValue(next), select) } : {})
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

                    const baseVersion = raw?.baseVersion
                    const value = raw?.value
                    const candidate = isPlainObject(value) ? { ...(value as any) } : value

                    const current = await this.adapter.get(resource, id)
                    if (!current) {
                        const next = candidate
                        if (isPlainObject(next)) {
                            next.id = id
                            if (!(typeof next.version === 'number' && Number.isFinite(next.version) && next.version >= 1)) {
                                next.version = 1
                            }
                        }
                        await this.adapter.put(resource, id, this.toStoredValue(next))
                        const version = isPlainObject(next) && typeof next.version === 'number' ? next.version : 1
                        results[index] = {
                            index,
                            ok: true,
                            entityId: id,
                            version,
                            ...(returning ? { data: projectSelect(this.toResponseValue(next), select) } : {})
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
                                current: { value: this.toResponseValue(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
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
                                current: { value: this.toResponseValue(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
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
                        next.id = id
                        next.version = nextVersion
                    }

                    await this.adapter.put(resource, id, this.toStoredValue(next))
                    results[index] = {
                        index,
                        ok: true,
                        entityId: id,
                        version: nextVersion,
                        ...(returning ? { data: projectSelect(this.toResponseValue(next), select) } : {})
                    }
                    continue
                }

                const entityId = raw?.entityId
                const id = String(entityId ?? '')
                if (!id) {
                    results[index] = { index, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing entityId for delete', kind: 'validation', details: { resource } }) }
                    continue
                }

                const current = await this.adapter.get(resource, id)
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
                        current: { value: this.toResponseValue(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                    }
                    continue
                }
                const nextVersion = baseVersion + 1
                await this.adapter.delete(resource, id)
                results[index] = { index, ok: true, entityId: id, version: nextVersion }
            } catch (err: any) {
                results[index] = {
                    index,
                    ok: false,
                    error: standardError({ code: 'WRITE_FAILED', message: 'Write failed', kind: 'internal', details: { resource, cause: String(err?.message ?? err) } })
                }
            }
        }

        return {
            transactionApplied: false,
            results
        } as WriteResultData
    }
}
