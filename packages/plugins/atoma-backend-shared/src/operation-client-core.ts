import { runQuery } from 'atoma-core/query'
import type { Entity, Query as CoreQuery } from 'atoma-types/core'
import type { ExecuteOperationsInput, ExecuteOperationsOutput, OperationClient } from 'atoma-types/client/ops'
import type {
    ChangeBatch,
    RemoteOp,
    RemoteOpResult,
    Query,
    QueryResultData,
    StandardError,
    WriteEntry,
    WriteOptions,
    WriteResultData
} from 'atoma-types/protocol'

type PlainRecord = Record<string, any>

export type OperationStorageAdapter = Readonly<{
    list: (resource: string) => Promise<any[]>
    get: (resource: string, id: string) => Promise<any | undefined>
    put: (resource: string, id: string, value: any) => Promise<void>
    delete: (resource: string, id: string) => Promise<void>
}>

export type StorageOperationClientOptions = Readonly<{
    adapter: OperationStorageAdapter
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

function normalizeEntryId(raw: unknown, fallback: string): string {
    return (typeof raw === 'string' && raw) ? raw : fallback
}

export class StorageOperationClient implements OperationClient {
    private readonly adapter: OperationStorageAdapter
    private readonly toStoredValue: (value: any) => any
    private readonly toResponseValue: (value: any) => any

    constructor(options: StorageOperationClientOptions) {
        if (!options || typeof options !== 'object') {
            throw new Error('[Atoma] StorageOperationClient: options is required')
        }
        if (!options.adapter || typeof options.adapter !== 'object') {
            throw new Error('[Atoma] StorageOperationClient: options.adapter is required')
        }
        if (typeof options.adapter.list !== 'function'
            || typeof options.adapter.get !== 'function'
            || typeof options.adapter.put !== 'function'
            || typeof options.adapter.delete !== 'function') {
            throw new Error('[Atoma] StorageOperationClient: adapter methods list/get/put/delete are required')
        }

        this.adapter = options.adapter
        this.toStoredValue = options.toStoredValue ?? (value => value)
        this.toResponseValue = options.toResponseValue ?? (value => value)
    }

    async executeOperations(input: ExecuteOperationsInput): Promise<ExecuteOperationsOutput> {
        const ops = Array.isArray(input.ops) ? input.ops : []
        const results: RemoteOpResult[] = []

        for (const op of ops) {
            results.push(await this.executeSingleOp(op))
        }

        return { results }
    }

    private async executeSingleOp(op: RemoteOp): Promise<RemoteOpResult> {
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
                const entries = Array.isArray(write?.entries) ? (write.entries as WriteEntry[]) : undefined
                if (typeof resource !== 'string' || !resource) {
                    return { opId, ok: false, error: standardError({ code: 'INVALID_REQUEST', message: 'Missing write.resource', kind: 'validation' }) }
                }
                if (!entries) {
                    return { opId, ok: false, error: standardError({ code: 'INVALID_REQUEST', message: 'Missing write.entries', kind: 'validation' }) }
                }
                const data = await this.executeWrite(resource, entries)
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

    private async executeWrite(resource: string, entries: WriteEntry[]): Promise<WriteResultData> {
        const results: any[] = new Array(entries.length)

        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index] as any
            const entryId = normalizeEntryId(entry?.entryId, `entry-${index}`)
            const action = entry?.action
            const raw = entry?.item
            const options = normalizeWriteOptions(entry?.options)

            const returning = options?.returning !== false
            const select = options?.select
            const merge = options?.merge !== false
            const upsertMode: 'strict' | 'loose' = options?.upsert?.mode === 'loose' ? 'loose' : 'strict'

            try {
                if (action === 'create') {
                    const rawId = raw?.id
                    if (rawId === undefined || rawId === null || rawId === '') {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing id for create', kind: 'validation', details: { resource } }) }
                        continue
                    }
                    const id = String(rawId)
                    const current = await this.adapter.get(resource, id)
                    if (current) {
                        const currentVersion = (current as any)?.version
                        results[index] = {
                            entryId,
                            ok: false,
                            error: standardError({ code: 'CONFLICT', message: 'Already exists', kind: 'conflict', details: { resource, id: id, currentVersion } }),
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
                        entryId,
                        ok: true,
                        id: id,
                        version,
                        ...(returning ? { data: projectSelect(this.toResponseValue(next), select) } : {})
                    }
                    continue
                }

                if (action === 'update') {
                    const id = String(raw?.id ?? '')
                    if (!id) {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing id for update', kind: 'validation', details: { resource } }) }
                        continue
                    }

                    const current = await this.adapter.get(resource, id)
                    if (!current) {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'NOT_FOUND', message: 'Not found', kind: 'not_found', details: { resource, id: id } }) }
                        continue
                    }

                    const baseVersion = raw?.baseVersion
                    const currentVersion = (current as any)?.version
                    if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing baseVersion for update', kind: 'validation', details: { resource, id: id } }) }
                        continue
                    }
                    if (typeof currentVersion !== 'number') {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing version field', kind: 'validation', details: { resource } }) }
                        continue
                    }
                    if (currentVersion !== baseVersion) {
                        results[index] = {
                            entryId,
                            ok: false,
                            error: standardError({ code: 'CONFLICT', message: 'Version conflict', kind: 'conflict', details: { resource, id: id, currentVersion } }),
                            current: { value: this.toResponseValue(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                        }
                        continue
                    }

                    const candidate = raw?.value
                    if (!isPlainObject(candidate)) {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing value for update', kind: 'validation', details: { resource, id: id } }) }
                        continue
                    }

                    const nextVersion = baseVersion + 1
                    const next = merge && isPlainObject(current)
                        ? { ...(current as any), ...(candidate as any) }
                        : { ...(candidate as any) }

                    if (isPlainObject(next)) {
                        next.id = id
                        next.version = nextVersion
                    }

                    await this.adapter.put(resource, id, this.toStoredValue(next))
                    results[index] = {
                        entryId,
                        ok: true,
                        id: id,
                        version: nextVersion,
                        ...(returning ? { data: projectSelect(this.toResponseValue(next), select) } : {})
                    }
                    continue
                }

                if (action === 'upsert') {
                    const id = String(raw?.id ?? '')
                    if (!id) {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing id for upsert', kind: 'validation', details: { resource } }) }
                        continue
                    }

                    const candidate = raw?.value
                    if (!isPlainObject(candidate)) {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing value for upsert', kind: 'validation', details: { resource, id: id } }) }
                        continue
                    }

                    const current = await this.adapter.get(resource, id)
                    const baseVersion = raw?.baseVersion

                    if (!current) {
                        if (upsertMode === 'strict' && !(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                            results[index] = {
                                entryId,
                                ok: false,
                                error: standardError({
                                    code: 'CONFLICT',
                                    message: 'Strict upsert requires baseVersion for existing entity',
                                    kind: 'conflict',
                                    details: { resource, id: id, hint: 'rebase' }
                                })
                            }
                            continue
                        }

                        const next = { ...(candidate as any), id, version: 1 }
                        await this.adapter.put(resource, id, this.toStoredValue(next))
                        results[index] = {
                            entryId,
                            ok: true,
                            id: id,
                            version: 1,
                            ...(returning ? { data: projectSelect(this.toResponseValue(next), select) } : {})
                        }
                        continue
                    }

                    const currentVersion = (current as any)?.version
                    if (upsertMode === 'strict') {
                        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion))) {
                            results[index] = {
                                entryId,
                                ok: false,
                                error: standardError({
                                    code: 'CONFLICT',
                                    message: 'Strict upsert requires baseVersion for existing entity',
                                    kind: 'conflict',
                                    details: { resource, id: id, currentVersion, hint: 'rebase' }
                                }),
                                current: { value: this.toResponseValue(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                            }
                            continue
                        }
                        if (typeof currentVersion !== 'number') {
                            results[index] = { entryId, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing version field', kind: 'validation', details: { resource } }) }
                            continue
                        }
                        if (currentVersion !== baseVersion) {
                            results[index] = {
                                entryId,
                                ok: false,
                                error: standardError({ code: 'CONFLICT', message: 'Version conflict', kind: 'conflict', details: { resource, id: id, currentVersion } }),
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
                        entryId,
                        ok: true,
                        id: id,
                        version: nextVersion,
                        ...(returning ? { data: projectSelect(this.toResponseValue(next), select) } : {})
                    }
                    continue
                }

                if (action === 'delete') {
                    const id = String(raw?.id ?? '')
                    if (!id) {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing id for delete', kind: 'validation', details: { resource } }) }
                        continue
                    }

                    const current = await this.adapter.get(resource, id)
                    if (!current) {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'NOT_FOUND', message: 'Not found', kind: 'not_found', details: { resource, id: id } }) }
                        continue
                    }
                    const baseVersion = raw?.baseVersion
                    const currentVersion = (current as any)?.version
                    if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing baseVersion for delete', kind: 'validation', details: { resource, id: id } }) }
                        continue
                    }
                    if (typeof currentVersion !== 'number') {
                        results[index] = { entryId, ok: false, error: standardError({ code: 'INVALID_WRITE', message: 'Missing version field', kind: 'validation', details: { resource } }) }
                        continue
                    }
                    if (currentVersion !== baseVersion) {
                        results[index] = {
                            entryId,
                            ok: false,
                            error: standardError({ code: 'CONFLICT', message: 'Version conflict', kind: 'conflict', details: { resource, id: id, currentVersion } }),
                            current: { value: this.toResponseValue(current), ...(typeof currentVersion === 'number' ? { version: currentVersion } : {}) }
                        }
                        continue
                    }
                    const nextVersion = baseVersion + 1
                    await this.adapter.delete(resource, id)
                    results[index] = { entryId, ok: true, id: id, version: nextVersion }
                    continue
                }

                results[index] = {
                    entryId,
                    ok: false,
                    error: standardError({ code: 'INVALID_WRITE', message: 'Invalid write entry action', kind: 'validation', details: { resource } })
                }
            } catch (err: any) {
                results[index] = {
                    entryId,
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
