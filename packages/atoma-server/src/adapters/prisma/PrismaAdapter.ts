import type { Query, SortRule, WriteOptions } from 'atoma-types/protocol'
import type {
    IOrmAdapter,
    OrmAdapterOptions,
    QueryResult,
    QueryResultMany,
    QueryResultOne
} from '../ports'
import {
    compareOpForAfter,
    decodeCursorToken,
    encodeCursorToken,
    ensureStableOrderBy,
    getCursorValuesFromRow,
    reverseOrderBy
} from '../shared/keyset'
import { createError, isAtomaError, throwError } from '../../error'
import { compileFilterToPrismaWhere } from '../../query/compile'

type PrismaDelegate = {
    findMany: (args: any) => Promise<any[]>
    count?: (args: any) => Promise<number>
    create?: (args: any) => Promise<any>
    update?: (args: any) => Promise<any>
    upsert?: (args: any) => Promise<any>
    delete?: (args: any) => Promise<any>
    createMany?: (args: any) => Promise<any>
    updateMany?: (args: any) => Promise<any>
    deleteMany?: (args: any) => Promise<any>
}

type PrismaClientLike = Record<string, any> & {
    $transaction?: {
        <T>(operations: Promise<T>[]): Promise<T[]>
        <T>(fn: (tx: any) => Promise<T>): Promise<T>
    }
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

export class AtomaPrismaAdapter implements IOrmAdapter {
    private readonly idField: string
    private readonly defaultSort?: SortRule[]
    private readonly adapterOptions: OrmAdapterOptions
    private readonly inTransaction: boolean

    constructor(
        private readonly client: PrismaClientLike,
        options: OrmAdapterOptions = {},
        inTransaction: boolean = false
    ) {
        this.adapterOptions = options
        this.inTransaction = inTransaction
        this.idField = options.idField ?? 'id'
        this.defaultSort = options.defaultSort
    }

    async transaction<T>(fn: (args: { orm: IOrmAdapter; tx: unknown }) => Promise<T>): Promise<T> {
        if (typeof this.client.$transaction !== 'function') {
            return fn({ orm: this, tx: undefined })
        }
        return (this.client.$transaction as any)(async (tx: any) => {
            const txOrm = new AtomaPrismaAdapter(tx, this.adapterOptions, true)
            return fn({ orm: txOrm, tx })
        })
    }

    async findMany(resource: string, query: Query = {}): Promise<QueryResult> {
        const delegate = this.getDelegate(resource)
        if (!delegate?.findMany) {
            throwError('RESOURCE_NOT_ALLOWED', `Resource not allowed: ${resource}`, { kind: 'auth', resource })
        }

        const orderBy = ensureStableOrderBy(query.sort, {
            idField: this.idField,
            defaultSort: this.defaultSort
        })

        const baseWhere = compileFilterToPrismaWhere(query.filter)
        const page = query.page
        const pageMode = page?.mode ?? undefined
        const beforeToken = (pageMode === 'cursor' && typeof (page as any).before === 'string') ? (page as any).before as string : undefined
        const afterToken = (pageMode === 'cursor' && typeof (page as any).after === 'string') ? (page as any).after as string : undefined

        const cursor = (pageMode === 'cursor' && (beforeToken || afterToken))
            ? { token: beforeToken ?? afterToken!, before: Boolean(beforeToken) }
            : undefined

        const { prismaOrderBy, reverseResult, keysetWhere } = this.buildKeysetWhere(cursor, orderBy)
        const where = keysetWhere ? this.andWhere(baseWhere, keysetWhere) : baseWhere

        const fields = normalizeFields(query.select)
        const { select, project } = this.buildSelectWithProjection(fields, orderBy)

        if (!page) {
            const data = await delegate.findMany({ where, orderBy: prismaOrderBy, select })
            const projected = project ? data.map(project) : data
            return { data: projected }
        }

        if (pageMode === 'offset') {
            const skip = normalizeOffset((page as any).offset) ?? 0
            const take = normalizeOptionalLimit((page as any).limit)
            const includeTotal = (page as any).includeTotal === true

            if (includeTotal && delegate.count && typeof take === 'number') {
                const [data, total] = await Promise.all([
                    delegate.findMany({ where, orderBy: prismaOrderBy, select, skip, take }),
                    delegate.count({ where })
                ])
                const projected = project ? data.map(project) : data
                return {
                    data: projected,
                    pageInfo: {
                        total,
                        hasNext: skip + take < total
                    }
                }
            }

            if (typeof take === 'number') {
                const data = await delegate.findMany({ where, orderBy: prismaOrderBy, select, skip, take: take + 1 })
                const hasNext = data.length > take
                const sliced = data.slice(0, take)
                const projected = project ? sliced.map(project) : sliced
                return {
                    data: projected,
                    pageInfo: { hasNext, ...(includeTotal && delegate.count ? { total: await delegate.count({ where }) } : {}) }
                }
            }

            const data = await delegate.findMany({ where, orderBy: prismaOrderBy, select, skip })
            const projected = project ? data.map(project) : data
            return {
                data: projected,
                pageInfo: { hasNext: false, ...(includeTotal && delegate.count ? { total: await delegate.count({ where }) } : {}) }
            }
        }

        // cursor keyset：默认不返回 total
        const take = normalizeOptionalLimit((page as any).limit) ?? 50
        const data = await delegate.findMany({
            where,
            orderBy: prismaOrderBy,
            select,
            take: take + 1
        })
        const hasNext = data.length > take
        const sliced = data.slice(0, take)
        const finalRows = reverseResult ? sliced.reverse() : sliced

        const projected = project ? finalRows.map(project) : finalRows
        const cursorRow = cursor?.before ? finalRows[0] : finalRows[finalRows.length - 1]
        const nextCursor = cursorRow
            ? encodeCursorToken(getCursorValuesFromRow(cursorRow, orderBy), orderBy)
            : undefined

        return {
            data: projected,
            pageInfo: {
                hasNext,
                cursor: nextCursor
            }
        }
    }

    async batchFindMany(requests: Array<{ resource: string; query: Query }>): Promise<QueryResult[]> {
        const operations = requests.map(r => this.findMany(r.resource, r.query))
        if (this.client.$transaction) {
            return this.client.$transaction(operations)
        }
        return Promise.all(operations)
    }

    async create(resource: string, data: any, options: WriteOptions = {}): Promise<QueryResultOne> {
        const delegate = this.requireDelegate(resource, 'create')
        const args: any = {
            data,
            select: this.buildSelect(options.select)
        }
        const row = await delegate.create!(args)
        return { data: options.returning === false ? undefined : row, transactionApplied: this.inTransaction }
    }

    async update(
        resource: string,
        item: { id: any; data: any; baseVersion?: number; timestamp?: number },
        options: WriteOptions = {}
    ): Promise<QueryResultOne> {
        if (item?.id === undefined || !item?.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
            throw new Error('update requires id and data object')
        }

        const run = async (client: PrismaClientLike) => {
            const delegate = this.requireDelegateFromClient(client, resource, 'update')
            const current = await this.findOneByKey(client, resource, this.idField, item.id)
            if (!current) {
                throwError('NOT_FOUND', 'Not found', { kind: 'not_found', resource, entityId: String(item.id) })
            }

            if (typeof item.baseVersion === 'number' && Number.isFinite(item.baseVersion)) {
                const currentVersion = (current as any).version
                if (typeof currentVersion !== 'number') {
                    throwError('INVALID_WRITE', 'Missing version field', { kind: 'validation', resource })
                }
                if (currentVersion !== item.baseVersion) {
                    throwError('CONFLICT', 'Version conflict', {
                        kind: 'conflict',
                        resource,
                        currentVersion,
                        currentValue: current
                    })
                }
            }

            const baseVersion = (current as any).version
            const next = { ...(item.data as any), [this.idField]: item.id }
            if (typeof item.baseVersion === 'number' && Number.isFinite(item.baseVersion) && typeof baseVersion === 'number') {
                next.version = baseVersion + 1
            }

            const data = this.toUpdateData(next, this.idField)
            const row = await delegate.update!({
                where: { [this.idField]: item.id },
                data,
                select: this.buildSelect(options.select)
            })
            return row
        }

        const row = await run(this.client)
        return { data: options.returning === false ? undefined : row, transactionApplied: this.inTransaction }
    }

    async delete(resource: string, whereOrId: any, options: WriteOptions = {}): Promise<QueryResultOne> {
        const baseVersion = (whereOrId && typeof whereOrId === 'object' && !Array.isArray(whereOrId))
            ? (whereOrId as any).baseVersion
            : undefined

        if (typeof baseVersion === 'number' && Number.isFinite(baseVersion)) {
            const id = (whereOrId as any).id
            if (id === undefined) throw new Error('delete requires id')

            const delegate = this.requireDelegateFromClient(this.client, resource, 'delete')
            const current = await this.findOneByKey(this.client, resource, this.idField, id)
            if (!current) {
                throwError('NOT_FOUND', 'Not found', { kind: 'not_found', resource, entityId: String(id) })
            }
            const currentVersion = (current as any).version
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

            await delegate.delete!({ where: { [this.idField]: id } })
            return { data: undefined, transactionApplied: this.inTransaction }
        }

        const delegate = this.requireDelegate(resource, 'delete')
        const where = this.normalizeWhereOrId(whereOrId)
        const args: any = {
            where,
            select: this.buildSelect(options.select)
        }
        const row = await delegate.delete!(args)
        return { data: options.returning === false ? undefined : row, transactionApplied: this.inTransaction }
    }

    async upsert(
        resource: string,
        item: { id: any; data: any; baseVersion?: number; timestamp?: number; mode?: 'strict' | 'loose'; merge?: boolean },
        options: WriteOptions = {}
    ): Promise<QueryResultOne> {
        const mode: 'strict' | 'loose' = item.mode === 'loose' ? 'loose' : 'strict'
        const id = item?.id
        if (id === undefined) throw new Error('upsert requires id')

        const candidate = (item?.data && typeof item.data === 'object' && !Array.isArray(item.data))
            ? { ...(item.data as any), [this.idField]: id }
            : { [this.idField]: id }

        const ensureCreateVersion = (data: any) => {
            const v = (data as any)?.version
            if (!(typeof v === 'number' && Number.isFinite(v) && v >= 1)) return { ...(data as any), version: 1 }
            return data
        }

        if (mode === 'loose') {
            const delegate = this.requireDelegate(resource, 'upsert')
            const createData = ensureCreateVersion(candidate)
            const updateData = this.toUpdateData(candidate, this.idField)
            const row = await delegate.upsert!({
                where: { [this.idField]: id },
                create: createData,
                update: {
                    ...updateData,
                    // loose: LWW，但仍保持 version 单调递增
                    version: { increment: 1 }
                },
                select: this.buildSelect(options.select)
            })
            return { data: options.returning === false ? undefined : row, transactionApplied: this.inTransaction }
        }

        const baseVersion = item.baseVersion
        if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion))) {
            const current = await this.findOneByKey(this.client, resource, this.idField, id)
            if (current) {
                const currentVersion = (current as any)?.version
                throwError('CONFLICT', 'Strict upsert requires baseVersion for existing entity', {
                    kind: 'conflict',
                    resource,
                    entityId: String(id),
                    currentVersion,
                    currentValue: current,
                    hint: 'rebase'
                })
            }
            return this.create(resource, ensureCreateVersion(candidate), options)
        }

        try {
            return await this.update(resource, {
                id,
                data: candidate,
                baseVersion,
                timestamp: item.timestamp
            }, options)
        } catch (err) {
            if (isAtomaError(err) && err.code === 'NOT_FOUND') {
                return this.create(resource, ensureCreateVersion(candidate), options)
            }
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

        if (this.inTransaction) {
            for (let i = 0; i < items.length; i++) {
                try {
                    const res = await this.upsert(resource, items[i], options)
                    resultsByIndex[i] = { ok: true, ...(returning ? { data: res.data } : {}) }
                } catch (err) {
                    resultsByIndex[i] = { ok: false, error: this.toError(err) }
                }
            }
            return { resultsByIndex, transactionApplied: true }
        }

        const settled = await Promise.allSettled(items.map(item => this.upsert(resource, item, options)))
        settled.forEach((res, idx) => {
            if (res.status === 'fulfilled') {
                resultsByIndex[idx] = { ok: true, ...(returning ? { data: res.value.data } : {}) }
                return
            }
            resultsByIndex[idx] = { ok: false, error: this.toError(res.reason) }
        })

        return { resultsByIndex, transactionApplied: false }
    }

    async bulkCreate(resource: string, items: any[], options: WriteOptions = {}): Promise<QueryResultMany> {
        const delegate = this.requireDelegate(resource, 'create')
        const returning = options.returning !== false
        const operations = items.map(item => () => delegate.create!({ data: item, select: this.buildSelect(options.select) }))
        const resultsByIndex: any[] = new Array(items.length)

        if (this.inTransaction) {
            for (let i = 0; i < operations.length; i++) {
                try {
                    const row = await operations[i]()
                    resultsByIndex[i] = { ok: true, ...(returning ? { data: row } : {}) }
                } catch (err) {
                    resultsByIndex[i] = { ok: false, error: this.toError(err) }
                }
            }
            return { resultsByIndex, transactionApplied: true }
        }

        const settled = await Promise.allSettled(operations.map(op => op()))
        settled.forEach((res, idx) => {
            if (res.status === 'fulfilled') {
                resultsByIndex[idx] = { ok: true, ...(returning ? { data: res.value } : {}) }
                return
            }
            resultsByIndex[idx] = { ok: false, error: this.toError(res.reason) }
        })

        return { resultsByIndex, transactionApplied: false }
    }

    async bulkUpdate(
        resource: string,
        items: Array<{ id: any; data: any; baseVersion?: number; timestamp?: number }>,
        options: WriteOptions = {}
    ): Promise<QueryResultMany> {
        const returning = options.returning !== false
        const resultsByIndex: any[] = new Array(items.length)

        if (this.inTransaction) {
            for (let i = 0; i < items.length; i++) {
                try {
                    const res = await this.update(resource, items[i], options)
                    resultsByIndex[i] = { ok: true, ...(returning ? { data: res.data } : {}) }
                } catch (err) {
                    resultsByIndex[i] = { ok: false, error: this.toError(err) }
                }
            }
            return { resultsByIndex, transactionApplied: true }
        }

        const settled = await Promise.allSettled(items.map(item => this.update(resource, item, options)))
        settled.forEach((res, idx) => {
            if (res.status === 'fulfilled') {
                resultsByIndex[idx] = { ok: true, ...(returning ? { data: res.value.data } : {}) }
                return
            }
            resultsByIndex[idx] = { ok: false, error: this.toError(res.reason) }
        })
        return { resultsByIndex, transactionApplied: false }
    }

    async bulkDelete(resource: string, items: Array<{ id: any; baseVersion?: number }>, options: WriteOptions = {}): Promise<QueryResultMany> {
        const returning = options.returning !== false
        const resultsByIndex: any[] = new Array(items.length)

        if (this.inTransaction) {
            for (let i = 0; i < items.length; i++) {
                const item = items[i]
                try {
                    const res = await this.delete(resource, { id: item.id, baseVersion: item.baseVersion }, options)
                    resultsByIndex[i] = { ok: true, ...(returning ? { data: res.data } : {}) }
                } catch (err) {
                    resultsByIndex[i] = { ok: false, error: this.toError(err) }
                }
            }
            return { resultsByIndex, transactionApplied: true }
        }

        const settled = await Promise.allSettled(items.map(item => this.delete(resource, { id: item.id, baseVersion: item.baseVersion }, options)))
        settled.forEach((res, idx) => {
            if (res.status === 'fulfilled') {
                resultsByIndex[idx] = { ok: true, ...(returning ? { data: res.value.data } : {}) }
                return
            }
            resultsByIndex[idx] = { ok: false, error: this.toError(res.reason) }
        })
        return { resultsByIndex, transactionApplied: false }
    }

    private buildOrderBy(orderBy: SortRule[]) {
        return orderBy.map(rule => ({ [rule.field]: rule.dir }))
    }

    private buildSelect(select?: Record<string, boolean>) {
        if (!select) return undefined
        const filtered: Record<string, boolean> = {}
        Object.entries(select).forEach(([field, enabled]) => {
            if (enabled) filtered[field] = true
        })
        return Object.keys(filtered).length ? filtered : undefined
    }

    private getDelegate(resource: string): PrismaDelegate | undefined {
        const delegate = (this.client as any)?.[resource]
        if (!delegate || typeof delegate.findMany !== 'function') return undefined
        return delegate as PrismaDelegate
    }

    private getDelegateFromClient(client: PrismaClientLike, resource: string): PrismaDelegate | undefined {
        const delegate = (client as any)?.[resource]
        if (!delegate || typeof delegate.findMany !== 'function') return undefined
        return delegate as PrismaDelegate
    }

    private requireDelegate(resource: string, method: keyof PrismaDelegate): PrismaDelegate {
        const delegate = this.getDelegate(resource)
        if (!delegate || typeof (delegate as any)[method] !== 'function') {
            throw new Error(`Resource not allowed or missing method ${method}: ${resource}`)
        }
        return delegate
    }

    private requireDelegateFromClient(client: PrismaClientLike, resource: string, method: keyof PrismaDelegate): PrismaDelegate {
        const delegate = this.getDelegateFromClient(client, resource)
        if (!delegate || typeof (delegate as any)[method] !== 'function') {
            throw new Error(`Resource not allowed or missing method ${method}: ${resource}`)
        }
        return delegate
    }

    private normalizeWhereOrId(whereOrId: any) {
        if (whereOrId && typeof whereOrId === 'object' && !Array.isArray(whereOrId)) return whereOrId
        return { id: whereOrId }
    }

    // 事务由 IOrmAdapter.transaction 作为宿主统一管理（不在单个方法内隐式开启事务）

    private toError(reason: any) {
        if (isAtomaError(reason)) return reason
        // Do not leak raw adapter/DB errors to clients.
        return createError('INTERNAL', 'Internal error', { kind: 'adapter' })
    }

    private async findOneByKey(client: PrismaClientLike, resource: string, field: string, value: any) {
        const delegate = this.requireDelegateFromClient(client, resource, 'findMany')
        const list = await delegate.findMany({
            where: { [field]: value },
            take: 1
        })
        return Array.isArray(list) ? list[0] : undefined
    }

    private toUpdateData(row: any, idField: string) {
        if (!row || typeof row !== 'object') return row
        const { [idField]: _id, ...rest } = row
        return rest
    }

    // patch/JSONPatch 已移除：不再需要 stripIdPrefix
    private buildKeysetWhere(cursor: { token: string; before: boolean } | undefined, orderBy: SortRule[]) {
        if (!cursor?.token) {
            return {
                prismaOrderBy: this.buildOrderBy(orderBy),
                reverseResult: false,
                keysetWhere: undefined as any
            }
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
        const keysetWhere = this.buildPrismaKeysetWhere(queryOrderBy, values, before ? 'before' : 'after')

        return {
            prismaOrderBy: this.buildOrderBy(queryOrderBy),
            reverseResult: before,
            keysetWhere
        }
    }

    private buildPrismaKeysetWhere(orderBy: SortRule[], values: any[], path: string) {
        if (values.length < orderBy.length) {
            throwError('INVALID_QUERY', 'Invalid cursor token', { kind: 'validation', path })
        }

        const or: any[] = []
        for (let i = 0; i < orderBy.length; i++) {
            const and: any[] = []
            for (let j = 0; j < i; j++) {
                and.push({ [orderBy[j].field]: values[j] })
            }
            const op = compareOpForAfter(orderBy[i].dir)
            and.push({ [orderBy[i].field]: { [op]: values[i] } })
            or.push({ AND: and })
        }

        return { OR: or }
    }

    private andWhere(a: any, b: any) {
        if (a && b) return { AND: [a, b] }
        return a || b
    }

    private buildSelectWithProjection(fields: string[] | undefined, orderBy: SortRule[]) {
        if (!fields?.length) {
            return { select: undefined as any, project: undefined as ((row: any) => any) | undefined }
        }

        const requiredFields = orderBy.map(r => r.field)
        const prismaSelect: Record<string, boolean> = {}

        fields.forEach(field => { prismaSelect[field] = true })
        requiredFields.forEach(field => {
            prismaSelect[field] = true
        })

        const finalSelect = Object.keys(prismaSelect).length ? prismaSelect : undefined
        const project = (row: any) => {
            const out: any = {}
            fields.forEach(field => { out[field] = row?.[field] })
            return out
        }

        return { select: finalSelect, project }
    }
}
