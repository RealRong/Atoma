import type {
    IOrmAdapter,
    OrmAdapterOptions,
    OrderByRule,
    QueryParams,
    QueryResult,
    QueryResultMany,
    QueryResultOne,
    WriteOptions
} from '../../types'
import { applyPatches, enablePatches } from 'immer'
import {
    compareOpForAfter,
    decodeCursorToken,
    encodeCursorToken,
    ensureStableOrderBy,
    getCursorValuesFromRow,
    reverseOrderBy
} from '../shared/keyset'
import { createError, isAtomaError, throwError } from '../../error'

enablePatches()

type PrismaDelegate = {
    findMany: (args: any) => Promise<any[]>
    count?: (args: any) => Promise<number>
    create?: (args: any) => Promise<any>
    update?: (args: any) => Promise<any>
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

export class AtomaPrismaAdapter implements IOrmAdapter {
    private readonly idField: string
    private readonly defaultOrderBy?: OrderByRule[]
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
        this.defaultOrderBy = options.defaultOrderBy
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

    async findMany(resource: string, params: QueryParams = {}): Promise<QueryResult> {
        const delegate = this.getDelegate(resource)
        if (!delegate?.findMany) {
            throwError('RESOURCE_NOT_ALLOWED', `Resource not allowed: ${resource}`, { kind: 'auth', resource })
        }

        const orderBy = ensureStableOrderBy(params.orderBy, {
            idField: this.idField,
            defaultOrderBy: this.defaultOrderBy
        })

        const baseWhere = this.buildWhere(params.where)
        const { prismaOrderBy, reverseResult, keysetWhere } = this.buildKeysetWhere(params, orderBy)
        const where = keysetWhere ? this.andWhere(baseWhere, keysetWhere) : baseWhere

        const { select, project } = this.buildSelectWithProjection(params.select, orderBy)

        const page = params.page
        if (!page) {
            const data = await delegate.findMany({
                where,
                orderBy: prismaOrderBy,
                select
            })
            return { data: project ? data.map(project) : data }
        }

        if (page.mode === 'offset') {
            const skip = typeof page.offset === 'number' ? page.offset : undefined
            const take = page.limit
            const includeTotal = page.includeTotal ?? true

            if (includeTotal && delegate.count) {
                const [data, total] = await Promise.all([
                    delegate.findMany({ where, orderBy: prismaOrderBy, select, skip, take }),
                    delegate.count({ where })
                ])
                const projected = project ? data.map(project) : data
                return {
                    data: projected,
                    pageInfo: {
                        total,
                        hasNext: typeof skip === 'number' ? skip + take < total : take < total
                    }
                }
            }

            const data = await delegate.findMany({ where, orderBy: prismaOrderBy, select, skip, take: take + 1 })
            const hasNext = data.length > take
            const sliced = data.slice(0, take)
            const projected = project ? sliced.map(project) : sliced
            return {
                data: projected,
                pageInfo: { hasNext }
            }
        }

        // cursor keyset：默认不返回 total
        const take = page.limit
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
        const cursorRow = page.before ? finalRows[0] : finalRows[finalRows.length - 1]
        const cursor = cursorRow
            ? encodeCursorToken(getCursorValuesFromRow(cursorRow, orderBy))
            : undefined

        return {
            data: projected,
            pageInfo: {
                hasNext,
                cursor
            }
        }
    }

    async batchFindMany(requests: Array<{ resource: string; params: QueryParams }>): Promise<QueryResult[]> {
        const operations = requests.map(r => this.findMany(r.resource, r.params))
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

    async update(resource: string, data: any, options: WriteOptions & { where?: Record<string, any> } = {}): Promise<QueryResultOne> {
        const delegate = this.requireDelegate(resource, 'update')
        const where = options.where ?? (data?.id !== undefined ? { id: data.id } : undefined)
        if (!where) throw new Error('update requires where or id')

        const args: any = {
            where,
            data,
            select: this.buildSelect(options.select)
        }

        const row = await delegate.update!(args)
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
            if (!current) throw new Error('Not found')
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

    async patch(
        resource: string,
        item: { id: any; patches: any[]; baseVersion?: number; timestamp?: number },
        options: WriteOptions = {}
    ): Promise<QueryResultOne> {
        if (item?.id === undefined || !Array.isArray(item?.patches)) {
            throw new Error('patch requires id and patches[]')
        }

        const run = async (client: PrismaClientLike) => {
            const delegate = this.requireDelegateFromClient(client, resource, 'update')
            const current = await this.findOneByKey(client, resource, this.idField, item.id)
            if (!current) throw new Error('Not found')

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

            const normalized = this.stripIdPrefix(item.patches, item.id)
            const next = applyPatches(current, normalized)
            const baseVersion = (current as any).version
            if (typeof item.baseVersion === 'number' && Number.isFinite(item.baseVersion) && typeof baseVersion === 'number') {
                ;(next as any).version = baseVersion + 1
            }
            const data = this.toUpdateData(next, this.idField)
            const updated = await delegate.update!({
                where: { [this.idField]: item.id },
                data,
                select: this.buildSelect(options.select)
            })
            return updated
        }

        const row = await run(this.client)
        return {
            data: options.returning === false ? undefined : row,
            transactionApplied: this.inTransaction
        }
    }

    async bulkPatch(
        resource: string,
        items: Array<{ id: any; patches: any[]; baseVersion?: number; timestamp?: number }>,
        options: WriteOptions = {}
    ): Promise<QueryResultMany> {
        const returning = options.returning !== false

        if (this.inTransaction) {
            const delegate = this.requireDelegate(resource, 'update')
            const updated: any[] = []
            for (const item of items) {
                if (item?.id === undefined || !Array.isArray(item?.patches)) {
                    throw new Error('bulkPatch item missing id or patches')
                }
                const current = await this.findOneByKey(this.client, resource, this.idField, item.id)
                if (!current) throw new Error('Not found')

                const normalized = this.stripIdPrefix(item.patches, item.id)
                const next = applyPatches(current, normalized)
                const data = this.toUpdateData(next, this.idField)
                const row = await delegate.update!({
                    where: { [this.idField]: item.id },
                    data,
                    select: this.buildSelect(options.select)
                })
                if (returning) updated.push(row)
            }

            return {
                data: returning ? updated : [],
                transactionApplied: true
            }
        }

        const operations = items.map(item => async () => {
            if (item?.id === undefined || !Array.isArray(item?.patches)) {
                throw new Error('bulkPatch item missing id or patches')
            }
            const delegate = this.requireDelegate(resource, 'update')
            const current = await this.findOneByKey(this.client, resource, this.idField, item.id)
            if (!current) throw new Error('Not found')

            const normalized = this.stripIdPrefix(item.patches, item.id)
            const next = applyPatches(current, normalized)
            const data = this.toUpdateData(next, this.idField)
            const row = await delegate.update!({
                where: { [this.idField]: item.id },
                data,
                select: this.buildSelect(options.select)
            })
            return returning ? row : undefined
        })

        const settled = await Promise.allSettled(operations.map(op => op()))
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []
        settled.forEach((res, idx) => {
            if (res.status === 'fulfilled') {
                if (returning && res.value !== undefined) data.push(res.value)
            } else {
                partialFailures.push({ index: idx, error: this.toError(res.reason) })
            }
        })

        return {
            data: returning ? data : [],
            partialFailures: partialFailures.length ? partialFailures : undefined,
            transactionApplied: false
        }
    }

    async bulkCreate(resource: string, items: any[], options: WriteOptions = {}): Promise<QueryResultMany> {
        const delegate = this.requireDelegate(resource, 'create')
        const operations = items.map(item => () => delegate.create!({ data: item, select: this.buildSelect(options.select) }))

        if (this.inTransaction) {
            const data: any[] = []
            for (const op of operations) {
                const row = await op()
                if (options.returning !== false) data.push(row)
            }
            return { data: options.returning === false ? [] : data, transactionApplied: true }
        }

        const settled = await Promise.allSettled(operations.map(op => op()))
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []
        settled.forEach((res, idx) => {
            if (res.status === 'fulfilled') data.push(res.value)
            else partialFailures.push({ index: idx, error: this.toError(res.reason) })
        })
        return {
            data: options.returning === false ? [] : data,
            partialFailures: partialFailures.length ? partialFailures : undefined,
            transactionApplied: false
        }
    }

    async bulkUpdate(resource: string, items: Array<{ id: any; data: any }>, options: WriteOptions = {}): Promise<QueryResultMany> {
        const delegate = this.requireDelegate(resource, 'update')
        const operations = items.map(item => {
            if (item.id === undefined) throw new Error('bulkUpdate item missing id')
            return () => delegate.update!({
                where: { id: item.id },
                data: item.data,
                select: this.buildSelect(options.select)
            })
        })

        if (this.inTransaction) {
            const data: any[] = []
            for (const op of operations) {
                const row = await op()
                if (options.returning !== false) data.push(row)
            }
            return { data: options.returning === false ? [] : data, transactionApplied: true }
        }

        const settled = await Promise.allSettled(operations.map(op => op()))
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []
        settled.forEach((res, idx) => {
            if (res.status === 'fulfilled') data.push(res.value)
            else partialFailures.push({ index: idx, error: this.toError(res.reason) })
        })
        return {
            data: options.returning === false ? [] : data,
            partialFailures: partialFailures.length ? partialFailures : undefined,
            transactionApplied: false
        }
    }

    async bulkDelete(resource: string, ids: any[], options: WriteOptions = {}): Promise<QueryResultMany> {
        const delegate = this.requireDelegate(resource, 'delete')
        const operations = ids.map(id => () => delegate.delete!({
            where: { id },
            select: this.buildSelect(options.select)
        }))

        if (this.inTransaction) {
            const data: any[] = []
            for (const op of operations) {
                const row = await op()
                if (options.returning !== false) data.push(row)
            }
            return { data: options.returning === false ? [] : data, transactionApplied: true }
        }

        const settled = await Promise.allSettled(operations.map(op => op()))
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []
        settled.forEach((res, idx) => {
            if (res.status === 'fulfilled') data.push(res.value)
            else partialFailures.push({ index: idx, error: this.toError(res.reason) })
        })
        return {
            data: options.returning === false ? [] : data,
            partialFailures: partialFailures.length ? partialFailures : undefined,
            transactionApplied: false
        }
    }

    private buildWhere(where: QueryParams['where']) {
        const result: Record<string, any> = {}
        if (where) {
            Object.entries(where).forEach(([field, value]) => {
                const mapped = this.mapWhereValue(value)
                if (mapped !== undefined) {
                    result[field] = mapped
                }
            })
        }
        return Object.keys(result).length ? result : undefined
    }

    private mapWhereValue(value: any) {
        if (value === undefined) return undefined
        if (Array.isArray(value)) {
            return { in: value }
        }
        if (value === null) return null
        if (this.isOperatorValue(value)) {
            const mapped: Record<string, any> = {}
            const { in: inArr, gt, gte, lt, lte, startsWith, endsWith, contains } = value
            if (inArr !== undefined) mapped.in = inArr
            if (gt !== undefined) mapped.gt = gt
            if (gte !== undefined) mapped.gte = gte
            if (lt !== undefined) mapped.lt = lt
            if (lte !== undefined) mapped.lte = lte
            if (startsWith !== undefined) mapped.startsWith = startsWith
            if (endsWith !== undefined) mapped.endsWith = endsWith
            if (contains !== undefined) mapped.contains = contains
            return mapped
        }
        return value
    }

    private buildOrderBy(orderBy: OrderByRule[]) {
        return orderBy.map(rule => ({ [rule.field]: rule.direction ?? 'asc' }))
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

    private isOperatorValue(value: any): value is {
        in?: any[]
        gt?: number
        gte?: number
        lt?: number
        lte?: number
        startsWith?: string
        endsWith?: string
        contains?: string
    } {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false
        return ['in', 'gt', 'gte', 'lt', 'lte', 'startsWith', 'endsWith', 'contains']
            .some(k => (value as any)[k] !== undefined)
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

    private buildKeysetWhere(params: QueryParams, orderBy: OrderByRule[]) {
        const page = params.page
        if (!page || page.mode !== 'cursor') {
            return {
                prismaOrderBy: this.buildOrderBy(orderBy),
                reverseResult: false,
                keysetWhere: undefined as any
            }
        }

        const before = Boolean(page.before)
        const token = page.before ?? page.after
        if (!token) {
            return {
                prismaOrderBy: this.buildOrderBy(orderBy),
                reverseResult: false,
                keysetWhere: undefined as any
            }
        }

        const queryOrderBy = before ? reverseOrderBy(orderBy) : orderBy
        let values: any[]
        try {
            values = decodeCursorToken(token)
        } catch {
            throwError('INVALID_QUERY', 'Invalid cursor token', { kind: 'validation', path: before ? 'page.before' : 'page.after' })
        }
        const keysetWhere = this.buildPrismaKeysetWhere(queryOrderBy, values, before ? 'page.before' : 'page.after')

        return {
            prismaOrderBy: this.buildOrderBy(queryOrderBy),
            reverseResult: before,
            keysetWhere
        }
    }

    private buildPrismaKeysetWhere(orderBy: OrderByRule[], values: any[], path: string) {
        if (values.length < orderBy.length) {
            throwError('INVALID_QUERY', 'Invalid cursor token', { kind: 'validation', path })
        }

        const or: any[] = []
        for (let i = 0; i < orderBy.length; i++) {
            const and: any[] = []
            for (let j = 0; j < i; j++) {
                and.push({ [orderBy[j].field]: values[j] })
            }
            const op = compareOpForAfter(orderBy[i].direction)
            and.push({ [orderBy[i].field]: { [op]: values[i] } })
            or.push({ AND: and })
        }

        return { OR: or }
    }

    private andWhere(a: any, b: any) {
        if (a && b) return { AND: [a, b] }
        return a || b
    }

    private buildSelectWithProjection(select: QueryParams['select'], orderBy: OrderByRule[]) {
        if (!select) {
            return { select: undefined as any, project: undefined as ((row: any) => any) | undefined }
        }

        const requiredFields = orderBy.map(r => r.field)
        const prismaSelect: Record<string, boolean> = {}

        Object.entries(select).forEach(([field, enabled]) => {
            if (enabled) prismaSelect[field] = true
        })
        requiredFields.forEach(field => {
            prismaSelect[field] = true
        })

        const finalSelect = Object.keys(prismaSelect).length ? prismaSelect : undefined
        const project = (row: any) => {
            const out: any = {}
            Object.entries(select).forEach(([field, enabled]) => {
                if (enabled) out[field] = row?.[field]
            })
            return out
        }

        return { select: finalSelect, project }
    }
}
