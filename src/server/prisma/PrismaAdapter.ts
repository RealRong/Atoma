import type {
    IOrmAdapter,
    QueryParams,
    QueryResult,
    QueryResultMany,
    QueryResultOne,
    WriteOptions
} from '../types'

export interface PrismaAdapterOptions {
    /** cursor 字段名，默认 id */
    cursorField?: string
    /** 是否强制禁用 $transaction 包裹批量查询 */
    disableTransaction?: boolean
}

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
    $transaction?: <T>(operations: Promise<T>[]) => Promise<T[]>
}

export class AtomaPrismaAdapter implements IOrmAdapter {
    private readonly cursorField: string
    private readonly disableTransaction: boolean

    constructor(
        private readonly client: PrismaClientLike,
        options: PrismaAdapterOptions = {}
    ) {
        this.cursorField = options.cursorField ?? 'id'
        this.disableTransaction = options.disableTransaction ?? false
    }

    isResourceAllowed(resource: string): boolean {
        return Boolean(this.getDelegate(resource)?.findMany)
    }

    async findMany(resource: string, params: QueryParams = {}): Promise<QueryResult> {
        const delegate = this.getDelegate(resource)
        if (!delegate?.findMany) {
            throw new Error(`Resource not allowed: ${resource}`)
        }

        const prismaWhere = this.buildWhere(params.where, params.cursor)
        const prismaOrderBy = this.buildOrderBy(params.orderBy)
        const select = this.buildSelect(params.select)
        const skip = typeof params.offset === 'number' ? params.offset : undefined
        const take = typeof params.limit === 'number' ? params.limit : undefined

        const [data, total] = await Promise.all([
            delegate.findMany({
                where: prismaWhere,
                orderBy: prismaOrderBy,
                select,
                skip,
                take
            }),
            delegate.count ? delegate.count({ where: prismaWhere }) : Promise.resolve(undefined)
        ])

        const pageInfo = typeof take === 'number'
            ? {
                total,
                hasNext: total !== undefined
                    ? (skip ?? 0) + take < total
                    : undefined
            }
            : { total }

        return { data, pageInfo }
    }

    async batchFindMany(requests: Array<{ resource: string; params: QueryParams }>): Promise<QueryResult[]> {
        const operations = requests.map(r => this.findMany(r.resource, r.params))
        if (!this.disableTransaction && this.client.$transaction) {
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
        const fn = () => delegate.create!(args)
        const res = await this.runMaybeTransaction([fn], options.transaction)
        return { data: res.data[0], transactionApplied: res.transactionApplied }
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

        const fn = () => delegate.update!(args)
        const res = await this.runMaybeTransaction([fn], options.transaction)
        return { data: res.data[0], transactionApplied: res.transactionApplied }
    }

    async delete(resource: string, whereOrId: any, options: WriteOptions = {}): Promise<QueryResultOne> {
        const delegate = this.requireDelegate(resource, 'delete')
        const where = this.normalizeWhereOrId(whereOrId)
        const args: any = {
            where,
            select: this.buildSelect(options.select)
        }
        const fn = () => delegate.delete!(args)
        const res = await this.runMaybeTransaction([fn], options.transaction)
        return { data: options.returning === false ? undefined : res.data[0], transactionApplied: res.transactionApplied }
    }

    async bulkCreate(resource: string, items: any[], options: WriteOptions = {}): Promise<QueryResultMany> {
        const delegate = this.requireDelegate(resource, 'create')
        const operations = items.map(item => () => delegate.create!({ data: item, select: this.buildSelect(options.select) }))

        if (options.transaction && this.client.$transaction) {
            const res = await this.runMaybeTransaction(operations, options.transaction)
            return { data: res.data, transactionApplied: res.transactionApplied }
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

        if (options.transaction && this.client.$transaction) {
            const res = await this.runMaybeTransaction(operations, options.transaction)
            return { data: res.data, transactionApplied: res.transactionApplied }
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

        if (options.transaction && this.client.$transaction) {
            const res = await this.runMaybeTransaction(operations, options.transaction)
            return { data: options.returning === false ? [] : res.data, transactionApplied: res.transactionApplied }
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

    private buildWhere(where: QueryParams['where'], cursor?: QueryParams['cursor']) {
        const result: Record<string, any> = {}
        if (where) {
            Object.entries(where).forEach(([field, value]) => {
                const mapped = this.mapWhereValue(value)
                if (mapped !== undefined) {
                    result[field] = mapped
                }
            })
        }
        if (cursor !== undefined) {
            const existing = result[this.cursorField]
            const cursorCond = { gt: cursor }
            if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
                result[this.cursorField] = { ...existing, ...cursorCond }
            } else {
                result[this.cursorField] = cursorCond
            }
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

    private buildOrderBy(orderBy: QueryParams['orderBy']) {
        if (!orderBy) return undefined
        const list = Array.isArray(orderBy) ? orderBy : [orderBy]
        return list.map(rule => ({ [rule.field]: rule.direction ?? 'asc' }))
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

    private requireDelegate(resource: string, method: keyof PrismaDelegate): PrismaDelegate {
        const delegate = this.getDelegate(resource)
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

    private async runMaybeTransaction(operations: Array<() => Promise<any>>, useTransaction?: boolean) {
        if (useTransaction && this.client.$transaction) {
            const data = await this.client.$transaction(operations.map(op => op()))
            return { data, transactionApplied: true }
        }
        const data = await Promise.all(operations.map(op => op()))
        return { data, transactionApplied: false }
    }

    private toError(reason: any) {
        if (reason?.code && reason?.message) return reason
        return { code: 'INTERNAL', message: reason?.message || String(reason), details: reason }
    }
}
