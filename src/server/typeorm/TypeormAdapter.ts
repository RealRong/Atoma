import type { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm'
import { applyPatches, enablePatches } from 'immer'
import {
    compareOpForAfter,
    decodeCursorToken,
    encodeCursorToken,
    ensureStableOrderBy,
    getCursorValuesFromRow,
    reverseOrderBy
} from '../adapters/shared/keyset'
import { createError, isAtomaError, throwError } from '../error'

enablePatches()
import type {
    IOrmAdapter,
    OrmAdapterOptions,
    OrderByRule,
    QueryParams,
    QueryResult,
    QueryResultMany,
    QueryResultOne,
    WriteOptions
} from '../types'

type OperatorValue = {
    in?: any[]
    gt?: number
    gte?: number
    lt?: number
    lte?: number
    startsWith?: string
    endsWith?: string
    contains?: string
}

type WhereValue = any | OperatorValue

export class AtomaTypeormAdapter implements IOrmAdapter {
    private paramIndex = 0
    private readonly idField: string
    private readonly defaultOrderBy?: OrderByRule[]
    private readonly adapterOptions: OrmAdapterOptions

    constructor(
        private readonly dataSource: DataSource,
        options: OrmAdapterOptions = {},
        private readonly manager?: EntityManager
    ) {
        this.adapterOptions = options
        this.idField = options.idField ?? 'id'
        this.defaultOrderBy = options.defaultOrderBy
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
            const debug = typeof process !== 'undefined'
                && process?.env
                && (process.env.ATOMA_DEBUG_ERRORS === '1' || process.env.ATOMA_DEBUG_ERRORS === 'true')
            if (debug) {
                // eslint-disable-next-line no-console
                console.error('[atoma] typeorm transaction failed', err)
            }
            await runner.rollbackTransaction()
            throw err
        } finally {
            await runner.release()
        }
    }

    async findMany(resource: string, params: QueryParams = {}): Promise<QueryResult> {
        const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
        const alias = this.getAlias(resource)
        const qb = repo.createQueryBuilder(alias)

        const orderBy = ensureStableOrderBy(params.orderBy, {
            idField: this.idField,
            defaultOrderBy: this.defaultOrderBy
        })

        this.applyWhere(qb, params.where, alias)

        const { queryOrderBy, reverseResult } = this.applyKeysetIfNeeded(qb, params.page, orderBy, alias)
        this.applyOrderBy(qb, queryOrderBy, alias)

        const { selectFields, project } = this.buildSelectFieldsWithProjection(params.select, orderBy, alias)
        if (selectFields) qb.select(selectFields)

        const page = params.page
        if (!page) {
            const data = await qb.getMany()
            return { data: project ? data.map(project) : data }
        }

        if (page.mode === 'offset') {
            const offset = typeof page.offset === 'number' ? page.offset : undefined
            const limit = page.limit
            const includeTotal = page.includeTotal ?? true

            if (typeof offset === 'number') qb.skip(offset)
            qb.take(limit)

            if (includeTotal) {
                const [data, total] = await qb.getManyAndCount()
                const projected = project ? data.map(project) : data
                const hasNext = (offset ?? 0) + limit < total
                return { data: projected, pageInfo: { total, hasNext } }
            }

            // 不返回 total：用 limit+1 判断 hasNext
            qb.take(limit + 1)
            const dataPlus = await qb.getMany()
            const hasNext = dataPlus.length > limit
            const sliced = dataPlus.slice(0, limit)
            const projected = project ? sliced.map(project) : sliced
            return { data: projected, pageInfo: { hasNext } }
        }

        // cursor keyset：默认不返回 total
        const limit = page.limit
        qb.take(limit + 1)
        const dataPlus = await qb.getMany()
        const hasNext = dataPlus.length > limit
        const sliced = dataPlus.slice(0, limit)
        const finalRows = reverseResult ? sliced.reverse() : sliced
        const projected = project ? finalRows.map(project) : finalRows

        const cursorRow = page.before ? finalRows[0] : finalRows[finalRows.length - 1]
        const cursor = cursorRow
            ? encodeCursorToken(getCursorValuesFromRow(cursorRow, orderBy))
            : undefined

        return {
            data: projected,
            pageInfo: { hasNext, cursor }
        }
    }

    async batchFindMany(requests: Array<{ resource: string; params: QueryParams }>): Promise<QueryResult[]> {
        return Promise.all(requests.map(r => this.findMany(r.resource, r.params)))
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

    async update(resource: string, data: any, options: WriteOptions & { where?: Record<string, any> } = {}): Promise<QueryResultOne> {
        try {
            const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
            const target = options.where ?? (data?.id !== undefined ? { [this.idField]: data.id } : undefined)
            if (!target) throw new Error('update requires where or id in data')
            await repo.update(target as any, data)
            const returning = options.returning !== false
            const fetched = returning ? await repo.findOne({ where: target as any, select: this.buildSelect(options.select, repo.metadata?.columns) }) : undefined
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
                    throwError('NOT_FOUND', 'Not found', { kind: 'validation', resource })
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

    async patch(
        resource: string,
        item: { id: any; patches: any[]; baseVersion?: number; timestamp?: number },
        options: WriteOptions = {}
    ): Promise<QueryResultOne> {
        try {
            const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
            if (item?.id === undefined || !Array.isArray(item?.patches)) {
                throw new Error('patch requires id and patches[]')
            }
            const current = await repo.findOne({ where: { [this.idField]: item.id } as any })
            if (!current) {
                throwError('NOT_FOUND', 'Not found', { kind: 'validation', resource })
            }
            // TypeORM 返回的是实体实例，Immer 需要可 draft 的 plain object
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
            const normalized = this.stripIdPrefix(item.patches, item.id)
            let next = applyPatches(base, normalized)
            const baseVersion = (base as any).version
            if (typeof item.baseVersion === 'number' && Number.isFinite(item.baseVersion) && typeof baseVersion === 'number') {
                if (next && typeof next === 'object' && !Array.isArray(next)) {
                    next = { ...(next as any), version: baseVersion + 1 }
                }
            }
            const input = this.pickKnownColumns(repo, next)
            const saved = await repo.save(input as any)
            const returning = options.returning !== false
            const data = returning
                ? (options.select ? await repo.findOne({
                    where: { [this.idField]: item.id } as any,
                    select: this.buildSelect(options.select, repo.metadata?.columns)
                }) : saved)
                : undefined
            return { data: returning ? data : undefined, transactionApplied: Boolean(this.manager) }
        } catch (err) {
            throw err
        }
    }

    async bulkCreate(resource: string, items: any[], options: WriteOptions = {}): Promise<QueryResultMany> {
        const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []

        for (let i = 0; i < items.length; i++) {
            try {
                const input = this.pickKnownColumns(repo, items[i])
                const saved = await repo.save(input)
                if (options.returning !== false) data.push(saved)
            } catch (err) {
                partialFailures.push({ index: i, error: this.toError(err) })
            }
        }

        return {
            data: options.returning === false ? [] : data,
            partialFailures: partialFailures.length ? partialFailures : undefined,
            transactionApplied: Boolean(this.manager)
        }
    }

    async bulkUpdate(resource: string, items: Array<{ id: any; data: any }>, options: WriteOptions = {}): Promise<QueryResultMany> {
        const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []

        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            try {
                if (item.id === undefined) throw new Error('bulkUpdate item missing id')
                await repo.update({ [this.idField]: item.id } as any, item.data)
                if (options.returning !== false) {
                    const fetched = await repo.findOneBy({ [this.idField]: item.id } as any)
                    if (fetched) data.push(fetched)
                }
            } catch (err) {
                partialFailures.push({ index: i, error: this.toError(err) })
            }
        }

        return {
            data: options.returning === false ? [] : data,
            partialFailures: partialFailures.length ? partialFailures : undefined,
            transactionApplied: Boolean(this.manager)
        }
    }

    async bulkDelete(resource: string, ids: any[], options: WriteOptions = {}): Promise<QueryResultMany> {
        const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i]
            try {
                const returning = options.returning === true
                if (returning) {
                    const fetched = await repo.findOneBy({ [this.idField]: id } as any)
                    if (fetched) data.push(fetched)
                }
                await repo.delete({ [this.idField]: id } as any)
            } catch (err) {
                partialFailures.push({ index: i, error: this.toError(err) })
            }
        }

        return {
            data: options.returning === true ? data : [],
            partialFailures: partialFailures.length ? partialFailures : undefined,
            transactionApplied: Boolean(this.manager)
        }
    }

    async bulkPatch(
        resource: string,
        items: Array<{ id: any; patches: any[]; baseVersion?: number; timestamp?: number }>,
        options: WriteOptions = {}
    ): Promise<QueryResultMany> {
        const repo = (this.manager ?? this.dataSource).getRepository(resource as any)
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []

        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            try {
                if (item.id === undefined || !Array.isArray(item.patches)) {
                    throw new Error('bulkPatch item missing id or patches')
                }
                const current = await repo.findOne({ where: { [this.idField]: item.id } as any })
                if (!current) throwError('NOT_FOUND', 'Not found', { kind: 'validation', resource })
                const base = this.toPlain(current)
                const normalized = this.stripIdPrefix(item.patches, item.id)
                const next = applyPatches(base, normalized)
                const input = this.pickKnownColumns(repo, next)
                const saved = await repo.save(input as any)
                if (options.returning !== false) {
                    data.push(options.select
                        ? await repo.findOne({
                            where: { [this.idField]: item.id } as any,
                            select: this.buildSelect(options.select, repo.metadata?.columns)
                        })
                        : saved)
                }
            } catch (err) {
                partialFailures.push({ index: i, error: this.toError(err) })
            }
        }

        return {
            data: options.returning === false ? [] : data,
            partialFailures: partialFailures.length ? partialFailures : undefined,
            transactionApplied: Boolean(this.manager)
        }
    }

    private applyWhere(qb: SelectQueryBuilder<any>, where: QueryParams['where'], alias: string) {
        if (!where) return

        Object.entries(where).forEach(([field, value]) => {
            if (value === undefined) return
            const column = `${alias}.${field}`

            if (Array.isArray(value)) {
                const key = this.nextParam(field)
                qb.andWhere(`${column} IN (:...${key})`, { [key]: value })
                return
            }

            if (value === null) {
                qb.andWhere(`${column} IS NULL`)
                return
            }

            if (this.isOperatorValue(value)) {
                this.applyOperators(qb, column, field, value)
                return
            }

            const key = this.nextParam(field)
            qb.andWhere(`${column} = :${key}`, { [key]: value })
        })
    }

    private applyOperators(qb: SelectQueryBuilder<any>, column: string, field: string, ops: OperatorValue) {
        if (ops.in) {
            const key = this.nextParam(`${field}_in`)
            qb.andWhere(`${column} IN (:...${key})`, { [key]: ops.in })
        }
        if (ops.gt !== undefined) {
            const key = this.nextParam(`${field}_gt`)
            qb.andWhere(`${column} > :${key}`, { [key]: ops.gt })
        }
        if (ops.gte !== undefined) {
            const key = this.nextParam(`${field}_gte`)
            qb.andWhere(`${column} >= :${key}`, { [key]: ops.gte })
        }
        if (ops.lt !== undefined) {
            const key = this.nextParam(`${field}_lt`)
            qb.andWhere(`${column} < :${key}`, { [key]: ops.lt })
        }
        if (ops.lte !== undefined) {
            const key = this.nextParam(`${field}_lte`)
            qb.andWhere(`${column} <= :${key}`, { [key]: ops.lte })
        }
        if (ops.startsWith !== undefined) {
            const key = this.nextParam(`${field}_sw`)
            qb.andWhere(`${column} LIKE :${key}`, { [key]: `${ops.startsWith}%` })
        }
        if (ops.endsWith !== undefined) {
            const key = this.nextParam(`${field}_ew`)
            qb.andWhere(`${column} LIKE :${key}`, { [key]: `%${ops.endsWith}` })
        }
        if (ops.contains !== undefined) {
            const key = this.nextParam(`${field}_ct`)
            qb.andWhere(`${column} LIKE :${key}`, { [key]: `%${ops.contains}%` })
        }
    }

    private applyOrderBy(qb: SelectQueryBuilder<any>, orderBy: OrderByRule[], alias: string) {
        orderBy.forEach((rule, idx) => {
            const direction = rule.direction?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
            const column = `${alias}.${rule.field}`
            if (idx === 0) qb.orderBy(column, direction)
            else qb.addOrderBy(column, direction)
        })
    }

    private applyKeysetIfNeeded(
        qb: SelectQueryBuilder<any>,
        page: QueryParams['page'],
        orderBy: OrderByRule[],
        alias: string
    ) {
        if (!page || page.mode !== 'cursor') {
            return { queryOrderBy: orderBy, reverseResult: false }
        }

        const before = Boolean(page.before)
        const token = page.before ?? page.after
        if (!token) {
            return { queryOrderBy: orderBy, reverseResult: false }
        }

        const queryOrderBy = before ? reverseOrderBy(orderBy) : orderBy
        let values: any[]
        try {
            values = decodeCursorToken(token)
        } catch {
            throwError('INVALID_QUERY', 'Invalid cursor token', { kind: 'validation', path: before ? 'page.before' : 'page.after' })
        }
        this.applyKeysetWhere(qb, queryOrderBy, values, alias, before ? 'page.before' : 'page.after')

        return { queryOrderBy, reverseResult: before }
    }

    private applyKeysetWhere(qb: SelectQueryBuilder<any>, orderBy: OrderByRule[], values: any[], alias: string, path: string) {
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
            const op = compareOpForAfter(orderBy[i].direction)
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

    private buildSelectFieldsWithProjection(select: QueryParams['select'], orderBy: OrderByRule[], alias: string) {
        if (!select) {
            return { selectFields: undefined as string[] | undefined, project: undefined as ((row: any) => any) | undefined }
        }

        const merged: Record<string, boolean> = {}
        Object.entries(select).forEach(([field, enabled]) => {
            if (enabled) merged[field] = true
        })
        orderBy.forEach(r => {
            merged[r.field] = true
        })

        const selectFields = this.buildSelectFields(merged, alias)
        const project = (row: any) => {
            const out: any = {}
            Object.entries(select).forEach(([field, enabled]) => {
                if (enabled) out[field] = row?.[field]
            })
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

    private isOperatorValue(value: WhereValue): value is OperatorValue {
        if (!value || typeof value !== 'object') return false
        return [
            'in',
            'gt',
            'gte',
            'lt',
            'lte',
            'startsWith',
            'endsWith',
            'contains'
        ].some(k => (value as Record<string, unknown>)[k] !== undefined)
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
        // 简单且安全地去掉原型，确保 Immer 可 draft
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

    private stripIdPrefix(patches: any[], id: any) {
        return (patches || []).map(patch => {
            if (!Array.isArray(patch.path) || !patch.path.length) return patch
            const [head, ...rest] = patch.path
            // 宽松比较以兼容字符串/数字 id
            if (head == id) {
                return { ...patch, path: rest }
            }
            return patch
        })
    }

    // 事务由 IOrmAdapter.transaction 作为宿主统一管理（不在单个方法内隐式开启事务）
}
