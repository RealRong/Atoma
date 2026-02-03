import type { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm'
import {
    compareOpForAfter,
    decodeCursorToken,
    encodeCursorToken,
    ensureStableOrderBy,
    getCursorValuesFromRow,
    reverseOrderBy
} from '../shared/keyset'
import { createError, isAtomaError, throwError } from '../../error'
import { compileFilterToSql } from '../../query/compile'

import type { Query, SortRule, WriteOptions } from 'atoma-types/protocol'
import type {
    IOrmAdapter,
    OrmAdapterOptions,
    QueryResult,
    QueryResultMany,
    QueryResultOne
} from '../ports'

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

export class AtomaTypeormAdapter implements IOrmAdapter {
    private paramIndex = 0
    private readonly idField: string
    private readonly defaultSort?: SortRule[]
    private readonly adapterOptions: OrmAdapterOptions

    constructor(
        private readonly dataSource: DataSource,
        options: OrmAdapterOptions = {},
        private readonly manager?: EntityManager
    ) {
        this.adapterOptions = options
        this.idField = options.idField ?? 'id'
        this.defaultSort = options.defaultSort
    }

    async transaction<T>(fn: (args: { orm: IOrmAdapter; tx: unknown }) => Promise<T>): Promise<T> {
        const runner = this.dataSource.createQueryRunner()
        try {
            await runner.startTransaction()
            const txOrm = new AtomaTypeormAdapter(this.dataSource, this.adapterOptions, runner.manager)
            const out = await fn({ orm: txOrm, tx: runner.manager })
            await runner.commitTransaction()
            return out
        } catch (err) {
            await runner.rollbackTransaction()
            throw err
        } finally {
            await runner.release()
        }
    }

    async findMany(resource: string, query: Query = {}): Promise<QueryResult> {
        const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
        const alias = this.getAlias(resource)
        const qb = repo.createQueryBuilder(alias)

        const orderBy = ensureStableOrderBy(query.sort, {
            idField: this.idField,
            defaultSort: this.defaultSort
        })

        const filter = compileFilterToSql(query.filter, { alias, nextParam: this.nextParam.bind(this) })
        if (filter) qb.andWhere(filter.sql, filter.params)

        const page = query.page
        const pageMode = page?.mode ?? undefined
        const beforeToken = (pageMode === 'cursor' && typeof (page as any).before === 'string') ? (page as any).before as string : undefined
        const afterToken = (pageMode === 'cursor' && typeof (page as any).after === 'string') ? (page as any).after as string : undefined

        const cursor = (pageMode === 'cursor' && (beforeToken || afterToken))
            ? { token: beforeToken ?? afterToken!, before: Boolean(beforeToken) }
            : undefined

        const { queryOrderBy, reverseResult } = this.applyKeysetIfNeeded(qb, cursor, orderBy, alias)
        this.applyOrderBy(qb, queryOrderBy, alias)

        const fields = normalizeFields(query.select)
        const { selectFields, project } = this.buildSelectFieldsWithProjection(fields, orderBy, alias)
        if (selectFields) qb.select(selectFields)

        if (!page) {
            const data = await qb.getMany()
            const projected = project ? data.map(project) : data
            return { data: projected }
        }

        if (pageMode === 'offset') {
            const offset = normalizeOffset((page as any).offset) ?? 0
            const includeTotal = (page as any).includeTotal === true

            if (typeof offset === 'number') qb.skip(offset)
            const limit = normalizeOptionalLimit((page as any).limit)
            if (typeof limit === 'number') qb.take(limit)

            if (includeTotal) {
                const [data, total] = await qb.getManyAndCount()
                const projected = project ? data.map(project) : data
                const hasNext = typeof limit === 'number' ? ((offset ?? 0) + limit < total) : false
                return { data: projected, pageInfo: { total, hasNext } }
            }

            // 不返回 total：用 limit+1 判断 hasNext
            if (typeof limit === 'number') {
                qb.take(limit + 1)
                const dataPlus = await qb.getMany()
                const hasNext = dataPlus.length > limit
                const sliced = dataPlus.slice(0, limit)
                const projected = project ? sliced.map(project) : sliced
                return { data: projected, pageInfo: { hasNext } }
            }

            const data = await qb.getMany()
            const projected = project ? data.map(project) : data
            return { data: projected, pageInfo: { hasNext: false } }
        }

        // cursor keyset：默认不返回 total
        const cursorLimit = normalizeOptionalLimit((page as any).limit) ?? 50
        qb.take(cursorLimit + 1)
        const dataPlus = await qb.getMany()
        const hasNext = dataPlus.length > cursorLimit
        const sliced = dataPlus.slice(0, cursorLimit)
        const finalRows = reverseResult ? sliced.reverse() : sliced
        const projected = project ? finalRows.map(project) : finalRows

        const cursorRow = cursor?.before ? finalRows[0] : finalRows[finalRows.length - 1]
        const nextCursor = cursorRow
            ? encodeCursorToken(getCursorValuesFromRow(cursorRow, orderBy), orderBy)
            : undefined

        return {
            data: projected,
            pageInfo: { hasNext, cursor: nextCursor }
        }
    }

    async batchFindMany(requests: Array<{ resource: string; query: Query }>): Promise<QueryResult[]> {
        return Promise.all(requests.map(r => this.findMany(r.resource, r.query)))
    }

    async create(resource: string, data: any, options: WriteOptions = {}): Promise<QueryResultOne> {
        try {
            const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
            const input = this.pickKnownColumns(repo, data)
            const saved = await repo.save(input)
            return { data: options.returning === false ? undefined : saved, transactionApplied: Boolean(this.manager) }
        } catch (err) {
            throw err
        }
    }

    async update(
        resource: string,
        item: { id: any; data: any; baseVersion?: number; timestamp?: number },
        options: WriteOptions = {}
    ): Promise<QueryResultOne> {
        try {
            const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
            if (item?.id === undefined || !item?.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
                throw new Error('update requires id and data object')
            }

            const current = await repo.findOne({ where: { [this.idField]: item.id } as any })
            if (!current) {
                throwError('NOT_FOUND', 'Not found', { kind: 'not_found', resource, entityId: String(item.id) })
            }

            const base = this.toPlain(current)
            if (typeof item.baseVersion === 'number' && Number.isFinite(item.baseVersion)) {
                const currentVersion = (base as any).version
                if (typeof currentVersion !== 'number') {
                    throwError('INVALID_WRITE', 'Missing version field', { kind: 'validation', resource })
                }
                if (currentVersion !== item.baseVersion) {
                    throwError('CONFLICT', 'Version conflict', {
                        kind: 'conflict',
                        resource,
                        currentVersion,
                        currentValue: base
                    })
                }
            }

            const baseVersion = (base as any).version
            const next = { ...(item.data as any), [this.idField]: item.id }
            if (typeof item.baseVersion === 'number' && Number.isFinite(item.baseVersion) && typeof baseVersion === 'number') {
                next.version = baseVersion + 1
            }

            const input = this.pickKnownColumns(repo, next)
            if (input && typeof input === 'object' && !Array.isArray(input)) {
                delete (input as any)[this.idField]
            }

            await repo.update({ [this.idField]: item.id } as any, input as any)
            const returning = options.returning !== false
            const fetched = returning
                ? await repo.findOne({
                    where: { [this.idField]: item.id } as any,
                    select: this.buildSelect(options.select, repo.metadata?.columns)
                })
                : undefined
            return { data: fetched ?? undefined, transactionApplied: Boolean(this.manager) }
        } catch (err) {
            throw err
        }
    }

    async delete(resource: string, whereOrId: any, options: WriteOptions = {}): Promise<QueryResultOne> {
        try {
            const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
            const baseVersion = (whereOrId && typeof whereOrId === 'object' && !Array.isArray(whereOrId))
                ? (whereOrId as any).baseVersion
                : undefined

            if (typeof baseVersion === 'number' && Number.isFinite(baseVersion)) {
                const id = (whereOrId as any).id
                if (id === undefined) throw new Error('delete requires id')
                const current = await repo.findOne({ where: { [this.idField]: id } as any })
                if (!current) {
                    throwError('NOT_FOUND', 'Not found', { kind: 'not_found', resource, entityId: String(id) })
                }
                const currentPlain = this.toPlain(current)
                const currentVersion = (currentPlain as any).version
                if (typeof currentVersion !== 'number') {
                    throwError('INVALID_WRITE', 'Missing version field', { kind: 'validation', resource })
                }
                if (currentVersion !== baseVersion) {
                    throwError('CONFLICT', 'Version conflict', {
                        kind: 'conflict',
                        resource,
                        currentVersion,
                        currentValue: currentPlain
                    })
                }

                await repo.delete({ [this.idField]: id } as any)
                return { data: undefined, transactionApplied: Boolean(this.manager) }
            }

            const where = this.normalizeWhereOrId(whereOrId)
            const returning = options.returning === true
            let deletedData: any | undefined
            if (returning) {
                deletedData = await repo.find({ where, select: this.buildSelect(options.select, repo.metadata?.columns) })
            }
            await repo.delete(where as any)
            return { data: returning ? deletedData : undefined, transactionApplied: Boolean(this.manager) }
        } catch (err) {
            throw err
        }
    }

    async bulkCreate(resource: string, items: any[], options: WriteOptions = {}): Promise<QueryResultMany> {
        const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
        const returning = options.returning !== false
        const resultsByIndex: any[] = new Array(items.length)

        for (let i = 0; i < items.length; i++) {
            try {
                const input = this.pickKnownColumns(repo, items[i])
                const saved = await repo.save(input)
                resultsByIndex[i] = { ok: true, ...(returning ? { data: saved } : {}) }
            } catch (err) {
                resultsByIndex[i] = { ok: false, error: this.toError(err) }
            }
        }

        return { resultsByIndex, transactionApplied: Boolean(this.manager) }
    }

    async bulkUpdate(
        resource: string,
        items: Array<{ id: any; data: any; baseVersion?: number; timestamp?: number }>,
        options: WriteOptions = {}
    ): Promise<QueryResultMany> {
        const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
        const returning = options.returning !== false
        const resultsByIndex: any[] = new Array(items.length)

        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            try {
                if (item.id === undefined) throw new Error('bulkUpdate item missing id')

                const current = await repo.findOne({ where: { [this.idField]: item.id } as any })
                if (!current) throwError('NOT_FOUND', 'Not found', { kind: 'not_found', resource, entityId: String(item.id) })

                const base = this.toPlain(current)
                if (typeof item.baseVersion === 'number' && Number.isFinite(item.baseVersion)) {
                    const currentVersion = (base as any).version
                    if (typeof currentVersion !== 'number') {
                        throwError('INVALID_WRITE', 'Missing version field', { kind: 'validation', resource })
                    }
                    if (currentVersion !== item.baseVersion) {
                        throwError('CONFLICT', 'Version conflict', {
                            kind: 'conflict',
                            resource,
                            currentVersion,
                            currentValue: base
                        })
                    }
                }

                const baseVersion = (base as any).version
                const next = { ...(item.data as any), [this.idField]: item.id }
                if (typeof item.baseVersion === 'number' && Number.isFinite(item.baseVersion) && typeof baseVersion === 'number') {
                    next.version = baseVersion + 1
                }

                const input = this.pickKnownColumns(repo, next)
                if (input && typeof input === 'object' && !Array.isArray(input)) {
                    delete (input as any)[this.idField]
                }

                await repo.update({ [this.idField]: item.id } as any, input as any)
                if (returning) {
                    const fetched = options.select
                        ? await repo.findOne({
                            where: { [this.idField]: item.id } as any,
                            select: this.buildSelect(options.select, repo.metadata?.columns)
                        })
                        : await repo.findOneBy({ [this.idField]: item.id } as any)
                    resultsByIndex[i] = { ok: true, data: fetched }
                } else {
                    resultsByIndex[i] = { ok: true }
                }
            } catch (err) {
                resultsByIndex[i] = { ok: false, error: this.toError(err) }
            }
        }

        return { resultsByIndex, transactionApplied: Boolean(this.manager) }
    }

    async bulkDelete(resource: string, items: Array<{ id: any; baseVersion?: number }>, options: WriteOptions = {}): Promise<QueryResultMany> {
        const returning = options.returning === true
        const resultsByIndex: any[] = new Array(items.length)

        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            try {
                const res = await this.delete(resource, { id: item.id, baseVersion: item.baseVersion }, options)
                resultsByIndex[i] = { ok: true, ...(returning ? { data: res.data } : {}) }
            } catch (err) {
                resultsByIndex[i] = { ok: false, error: this.toError(err) }
            }
        }

        return { resultsByIndex, transactionApplied: Boolean(this.manager) }
    }

    async upsert(
        resource: string,
        item: { id: any; data: any; baseVersion?: number; timestamp?: number; mode?: 'strict' | 'loose'; merge?: boolean },
        options: WriteOptions = {}
    ): Promise<QueryResultOne> {
        try {
            const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
            if (item?.id === undefined) throw new Error('upsert requires id')

            const mode: 'strict' | 'loose' = item.mode === 'loose' ? 'loose' : 'strict'
            const merge: boolean = item.merge !== undefined ? item.merge : (options.merge !== false)

            const candidate = (item?.data && typeof item.data === 'object' && !Array.isArray(item.data))
                ? { ...(item.data as any), [this.idField]: item.id }
                : { [this.idField]: item.id }

            const ensureCreateVersion = (data: any) => {
                const v = (data as any)?.version
                if (!(typeof v === 'number' && Number.isFinite(v) && v >= 1)) return { ...(data as any), version: 1 }
                return data
            }

            const readCurrentPlain = async () => {
                const cur = await repo.findOne({ where: { [this.idField]: item.id } as any })
                return cur ? this.toPlain(cur) : undefined
            }

            const insertOrThrow = async (data: any) => {
                const input = this.pickKnownColumns(repo, data)
                await repo.insert(input as any)
            }

            const fetchReturning = async () => {
                if (options.returning === false) return undefined
                if (options.select) {
                    return await repo.findOne({
                        where: { [this.idField]: item.id } as any,
                        select: this.buildSelect(options.select, repo.metadata?.columns)
                    })
                }
                return await repo.findOneBy({ [this.idField]: item.id } as any)
            }

            const saveReturning = async (data: any) => {
                const input = this.pickKnownColumns(repo, data)
                const saved = await repo.save(input as any)
                if (options.returning === false) return undefined
                if (options.select) {
                    return await repo.findOne({
                        where: { [this.idField]: item.id } as any,
                        select: this.buildSelect(options.select, repo.metadata?.columns)
                    })
                }
                return saved
            }

            if (mode === 'strict') {
                const baseVersion = item.baseVersion
                if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion))) {
                    const current = await readCurrentPlain()
                    if (current) {
                        const currentVersion = (current as any)?.version
                        throwError('CONFLICT', 'Strict upsert requires baseVersion for existing entity', {
                            kind: 'conflict',
                            resource,
                            entityId: String(item.id),
                            currentVersion,
                            currentValue: current,
                            hint: 'rebase'
                        })
                    }
                    await insertOrThrow(ensureCreateVersion(candidate))
                    const row = await fetchReturning()
                    return { data: row, transactionApplied: Boolean(this.manager) }
                }

                const current = await readCurrentPlain()
                if (!current) {
                    await insertOrThrow(ensureCreateVersion(candidate))
                    const row = await fetchReturning()
                    return { data: row, transactionApplied: Boolean(this.manager) }
                }

                const currentVersion = (current as any)?.version
                if (typeof currentVersion !== 'number') {
                    throwError('INVALID_WRITE', 'Missing version field', { kind: 'validation', resource })
                }
                if (currentVersion !== baseVersion) {
                    throwError('CONFLICT', 'Version conflict', {
                        kind: 'conflict',
                        resource,
                        currentVersion,
                        currentValue: current
                    })
                }

                const nextVersion = baseVersion + 1
                const next = merge
                    ? { ...(current as any), ...(candidate as any), [this.idField]: item.id, version: nextVersion }
                    : { ...(candidate as any), [this.idField]: item.id, version: nextVersion, createdAt: (current as any)?.createdAt }

                const row = await saveReturning(next)
                return { data: row, transactionApplied: Boolean(this.manager) }
            }

            // loose
            for (let attempt = 0; attempt < 3; attempt++) {
                const current = await readCurrentPlain()
                if (!current) {
                    try {
                        await insertOrThrow(ensureCreateVersion(candidate))
                        const row = await fetchReturning()
                        return { data: row, transactionApplied: Boolean(this.manager) }
                    } catch (err) {
                        // 可能 insert 竞争失败：重试为更新（不做 CONFLICT）
                        continue
                    }
                }

                const currentVersion = (current as any)?.version
                if (typeof currentVersion !== 'number' || !Number.isFinite(currentVersion)) {
                    throwError('INVALID_WRITE', 'Missing version field', { kind: 'validation', resource })
                }

                const nextVersion = currentVersion + 1
                const next = merge
                    ? { ...(current as any), ...(candidate as any), [this.idField]: item.id, version: nextVersion }
                    : { ...(candidate as any), [this.idField]: item.id, version: nextVersion, createdAt: (current as any)?.createdAt }

                const row = await saveReturning(next)
                return { data: row, transactionApplied: Boolean(this.manager) }
            }

            // 极端竞争：最后兜底尝试一次更新
            const current = await readCurrentPlain()
            if (current) {
                const currentVersion = (current as any)?.version
                if (typeof currentVersion !== 'number' || !Number.isFinite(currentVersion)) {
                    throwError('INVALID_WRITE', 'Missing version field', { kind: 'validation', resource })
                }
                const nextVersion = currentVersion + 1
                const next = merge
                    ? { ...(current as any), ...(candidate as any), [this.idField]: item.id, version: nextVersion }
                    : { ...(candidate as any), [this.idField]: item.id, version: nextVersion, createdAt: (current as any)?.createdAt }
                const row = await saveReturning(next)
                return { data: row, transactionApplied: Boolean(this.manager) }
            }

            await insertOrThrow(ensureCreateVersion(candidate))
            const row = await fetchReturning()
            return { data: row, transactionApplied: Boolean(this.manager) }
        } catch (err) {
            throw err
        }
    }

    async bulkUpsert(
        resource: string,
        items: Array<{ id: any; data: any; baseVersion?: number; timestamp?: number; mode?: 'strict' | 'loose'; merge?: boolean }>,
        options: WriteOptions = {}
    ): Promise<QueryResultMany> {
        const returning = options.returning !== false
        const resultsByIndex: any[] = new Array(items.length)

        for (let i = 0; i < items.length; i++) {
            try {
                const res = await this.upsert(resource, items[i], options)
                resultsByIndex[i] = { ok: true, ...(returning ? { data: res.data } : {}) }
            } catch (err) {
                resultsByIndex[i] = { ok: false, error: this.toError(err) }
            }
        }

        return { resultsByIndex, transactionApplied: Boolean(this.manager) }
    }

    private applyOrderBy(qb: SelectQueryBuilder<any>, orderBy: SortRule[], alias: string) {
        orderBy.forEach((rule, idx) => {
            const direction = rule.dir === 'asc' ? 'ASC' : 'DESC'
            const column = `${alias}.${rule.field}`
            if (idx === 0) qb.orderBy(column, direction)
            else qb.addOrderBy(column, direction)
        })
    }

    private applyKeysetIfNeeded(
        qb: SelectQueryBuilder<any>,
        cursor: { token: string; before: boolean } | undefined,
        orderBy: SortRule[],
        alias: string
    ) {
        if (!cursor?.token) {
            return { queryOrderBy: orderBy, reverseResult: false }
        }

        const before = cursor.before
        const token = cursor.token
        const queryOrderBy = before ? reverseOrderBy(orderBy) : orderBy
        let values: any[]
        try {
            values = decodeCursorToken(token)
        } catch {
            throwError('INVALID_QUERY', 'Invalid cursor token', { kind: 'validation', path: before ? 'before' : 'after' })
        }
        this.applyKeysetWhere(qb, queryOrderBy, values, alias, before ? 'before' : 'after')

        return { queryOrderBy, reverseResult: before }
    }

    private applyKeysetWhere(qb: SelectQueryBuilder<any>, orderBy: SortRule[], values: any[], alias: string, path: string) {
        if (values.length < orderBy.length) {
            throwError('INVALID_QUERY', 'Invalid cursor token', { kind: 'validation', path })
        }

        const orParts: string[] = []
        const params: Record<string, any> = {}

        for (let i = 0; i < orderBy.length; i++) {
            const andParts: string[] = []

            for (let j = 0; j < i; j++) {
                const field = orderBy[j].field
                const column = `${alias}.${field}`
                const value = values[j]
                if (value === null) {
                    andParts.push(`${column} IS NULL`)
                } else {
                    const key = this.nextParam(`ks_eq_${field}`)
                    andParts.push(`${column} = :${key}`)
                    params[key] = value
                }
            }

            const field = orderBy[i].field
            const column = `${alias}.${field}`
            const value = values[i]
            const op = compareOpForAfter(orderBy[i].dir)
            const sqlOp = op === 'gt' ? '>' : '<'
            const key = this.nextParam(`ks_cmp_${field}`)
            andParts.push(`${column} ${sqlOp} :${key}`)
            params[key] = value

            orParts.push(`(${andParts.join(' AND ')})`)
        }

        qb.andWhere(`(${orParts.join(' OR ')})`, params)
    }

    private buildSelectFields(select: Record<string, boolean>, alias: string) {
        const fields = Object.entries(select).filter(([, enabled]) => enabled).map(([key]) => `${alias}.${key}`)
        return fields.length ? fields : undefined
    }

    private buildSelectFieldsWithProjection(fields: string[] | undefined, orderBy: SortRule[], alias: string) {
        if (!fields?.length) {
            return { selectFields: undefined as string[] | undefined, project: undefined as ((row: any) => any) | undefined }
        }

        const merged: Record<string, boolean> = {}
        fields.forEach(field => { merged[field] = true })
        orderBy.forEach(r => { merged[r.field] = true })

        const selectFields = this.buildSelectFields(merged, alias)
        const project = (row: any) => {
            const out: any = {}
            fields.forEach(field => { out[field] = row?.[field] })
            return out
        }

        return { selectFields, project }
    }

    private buildSelect(select: Record<string, boolean> | undefined, columns?: Array<{ propertyName: string }>) {
        if (!select || !columns) return undefined
        const keys = Object.entries(select).filter(([, v]) => v).map(([k]) => k)
        if (!keys.length) return undefined
        return columns
            .filter(col => keys.includes(col.propertyName))
            .map(col => col.propertyName) as any
    }

    private nextParam(field: string) {
        return `${field}_${this.paramIndex++}`
    }

    private getAlias(resource: string) {
        return resource
    }

    private normalizeWhereOrId(whereOrId: any) {
        if (whereOrId && typeof whereOrId === 'object' && !Array.isArray(whereOrId)) return whereOrId
        return { [this.idField]: whereOrId }
    }

    private toError(err: any) {
        if (isAtomaError(err)) return err
        // Do not leak raw adapter/DB errors to clients.
        return createError('INTERNAL', 'Internal error', { kind: 'adapter' })
    }

    private toPlain(obj: any) {
        return obj ? JSON.parse(JSON.stringify(obj)) : obj
    }

    private pickKnownColumns(repo: any, value: any) {
        const columns = repo?.metadata?.columns
        if (!Array.isArray(columns) || !columns.length) return value
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value
        const out: Record<string, any> = {}
        for (const c of columns) {
            const k = (c as any)?.propertyName
            if (typeof k !== 'string' || !k) continue
            if (Object.prototype.hasOwnProperty.call(value, k)) {
                out[k] = (value as any)[k]
            }
        }
        return out
    }

    // 事务由 IOrmAdapter.transaction 作为宿主统一管理（不在单个方法内隐式开启事务）
}
