import type { DataSource, SelectQueryBuilder } from 'typeorm'
import { applyPatches, enablePatches } from 'immer'

enablePatches()
import type {
    IOrmAdapter,
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

export interface TypeormAdapterOptions {
    aliasPrefix?: string
}

export class AtomaTypeormAdapter implements IOrmAdapter {
    private paramIndex = 0

    constructor(
        private readonly dataSource: DataSource,
        private readonly options: TypeormAdapterOptions = {}
    ) {}

    isResourceAllowed(resource: string): boolean {
        try {
            this.dataSource.getMetadata(resource as any)
            return true
        } catch {
            return false
        }
    }

    async findMany(resource: string, params: QueryParams = {}): Promise<QueryResult> {
        const repo = this.dataSource.getRepository(resource as any)
        const alias = this.getAlias(resource)
        const qb = repo.createQueryBuilder(alias)

        this.applyWhere(qb, params.where, alias)
        this.applyOrderBy(qb, params.orderBy, alias)
        this.applyCursor(qb, params.cursor, alias)

        if (typeof params.offset === 'number') qb.skip(params.offset)
        if (typeof params.limit === 'number') qb.take(params.limit)
        const selectFields = params.select ? this.buildSelectFields(params.select, alias) : undefined
        if (selectFields) qb.select(selectFields)

        const [data, total] = await qb.getManyAndCount()
        const hasNext = typeof params.limit === 'number'
            ? (params.offset ?? 0) + params.limit < total
            : undefined

        return { data, pageInfo: { total, hasNext } }
    }

    async batchFindMany(requests: Array<{ resource: string; params: QueryParams }>): Promise<QueryResult[]> {
        return Promise.all(requests.map(r => this.findMany(r.resource, r.params)))
    }

    async create(resource: string, data: any, options: WriteOptions = {}): Promise<QueryResultOne> {
        const runner = options.transaction ? this.dataSource.createQueryRunner() : undefined
        try {
            if (runner) await runner.startTransaction()
            const repo = (runner?.manager ?? this.dataSource).getRepository(resource as any)
            const saved = await repo.save(data)
            if (runner) await runner.commitTransaction()
            return { data: options.returning === false ? undefined : saved, transactionApplied: Boolean(runner) }
        } catch (err) {
            if (runner) await runner.rollbackTransaction()
            throw err
        } finally {
            if (runner) await runner.release()
        }
    }

    async update(resource: string, data: any, options: WriteOptions & { where?: Record<string, any> } = {}): Promise<QueryResultOne> {
        const runner = options.transaction ? this.dataSource.createQueryRunner() : undefined
        try {
            if (runner) await runner.startTransaction()
            const repo = (runner?.manager ?? this.dataSource).getRepository(resource as any)
            const target = options.where ?? (data?.id !== undefined ? { id: data.id } : undefined)
            if (!target) throw new Error('update requires where or id in data')
            await repo.update(target as any, data)
            const returning = options.returning !== false
            const fetched = returning ? await repo.findOne({ where: target as any, select: this.buildSelect(options.select, repo.metadata?.columns) }) : undefined
            if (runner) await runner.commitTransaction()
            return { data: fetched ?? undefined, transactionApplied: Boolean(runner) }
        } catch (err) {
            if (runner) await runner.rollbackTransaction()
            throw err
        } finally {
            if (runner) await runner.release()
        }
    }

    async delete(resource: string, whereOrId: any, options: WriteOptions = {}): Promise<QueryResultOne> {
        const runner = options.transaction ? this.dataSource.createQueryRunner() : undefined
        try {
            if (runner) await runner.startTransaction()
            const repo = (runner?.manager ?? this.dataSource).getRepository(resource as any)
            const where = this.normalizeWhereOrId(whereOrId)
            const returning = options.returning === true
            let deletedData: any | undefined
            if (returning) {
                deletedData = await repo.find({ where, select: this.buildSelect(options.select, repo.metadata?.columns) })
            }
            await repo.delete(where as any)
            if (runner) await runner.commitTransaction()
            return { data: returning ? deletedData : undefined, transactionApplied: Boolean(runner) }
        } catch (err) {
            if (runner) await runner.rollbackTransaction()
            throw err
        } finally {
            if (runner) await runner.release()
        }
    }

    async patch(
        resource: string,
        item: { id: any; patches: any[]; baseVersion?: number; timestamp?: number },
        options: WriteOptions = {}
    ): Promise<QueryResultOne> {
        const runner = options.transaction ? this.dataSource.createQueryRunner() : undefined
        try {
            if (runner) await runner.startTransaction()
            const repo = (runner?.manager ?? this.dataSource).getRepository(resource as any)
            if (item?.id === undefined || !Array.isArray(item?.patches)) {
                throw new Error('patch requires id and patches[]')
            }
            const current = await repo.findOne({ where: { id: item.id } as any })
            if (!current) {
                throw new Error('Not found')
            }
            // TypeORM 返回的是实体实例，Immer 需要可 draft 的 plain object
            const base = this.toPlain(current)
            const normalized = this.stripIdPrefix(item.patches, item.id)
            const next = applyPatches(base, normalized)
            const saved = await repo.save(next as any)
            const returning = options.returning !== false
            const data = returning
                ? (options.select ? await repo.findOne({
                    where: { id: item.id } as any,
                    select: this.buildSelect(options.select, repo.metadata?.columns)
                }) : saved)
                : undefined
            if (runner) await runner.commitTransaction()
            return { data: returning ? data : undefined, transactionApplied: Boolean(runner) }
        } catch (err) {
            if (runner) await runner.rollbackTransaction()
            throw err
        } finally {
            if (runner) await runner.release()
        }
    }

    async bulkCreate(resource: string, items: any[], options: WriteOptions = {}): Promise<QueryResultMany> {
        if (options.transaction) {
            return this.runBulk(resource, items, options, async (repo, payload) => {
                const saved = await repo.save(payload)
                return options.returning === false ? [] : saved
            })
        }

        const repo = this.dataSource.getRepository(resource as any)
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []

        for (let i = 0; i < items.length; i++) {
            try {
                const saved = await repo.save(items[i])
                if (options.returning !== false) data.push(saved)
            } catch (err) {
                partialFailures.push({ index: i, error: this.toError(err) })
            }
        }

        return {
            data: options.returning === false ? [] : data,
            partialFailures: partialFailures.length ? partialFailures : undefined,
            transactionApplied: false
        }
    }

    async bulkUpdate(resource: string, items: Array<{ id: any; data: any }>, options: WriteOptions = {}): Promise<QueryResultMany> {
        if (options.transaction) {
            return this.runBulk(resource, items, options, async (repo, payload) => {
                for (const item of payload) {
                    if (item.id === undefined) throw new Error('bulkUpdate item missing id')
                    await repo.update({ id: item.id } as any, item.data)
                }
                if (options.returning === false) return []
                const ids = payload.map(p => p.id)
                return repo.findBy({ id: ids as any } as any)
            })
        }

        const repo = this.dataSource.getRepository(resource as any)
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []

        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            try {
                if (item.id === undefined) throw new Error('bulkUpdate item missing id')
                await repo.update({ id: item.id } as any, item.data)
                if (options.returning !== false) {
                    const fetched = await repo.findOneBy({ id: item.id } as any)
                    if (fetched) data.push(fetched)
                }
            } catch (err) {
                partialFailures.push({ index: i, error: this.toError(err) })
            }
        }

        return {
            data: options.returning === false ? [] : data,
            partialFailures: partialFailures.length ? partialFailures : undefined,
            transactionApplied: false
        }
    }

    async bulkDelete(resource: string, ids: any[], options: WriteOptions = {}): Promise<QueryResultMany> {
        if (options.transaction) {
            return this.runBulk(resource, ids, options, async (repo, payload) => {
                const where = Array.isArray(payload) ? { id: payload as any } : payload
                const returning = options.returning === true
                let deleted: any[] | undefined
                if (returning) {
                    deleted = await repo.findBy({ id: payload as any } as any)
                }
                await repo.delete(where as any)
                return returning ? deleted : []
            })
        }

        const repo = this.dataSource.getRepository(resource as any)
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i]
            try {
                const returning = options.returning === true
                if (returning) {
                    const fetched = await repo.findOneBy({ id } as any)
                    if (fetched) data.push(fetched)
                }
                await repo.delete({ id } as any)
            } catch (err) {
                partialFailures.push({ index: i, error: this.toError(err) })
            }
        }

        return {
            data: options.returning === true ? data : [],
            partialFailures: partialFailures.length ? partialFailures : undefined,
            transactionApplied: false
        }
    }

    async bulkPatch(
        resource: string,
        items: Array<{ id: any; patches: any[]; baseVersion?: number; timestamp?: number }>,
        options: WriteOptions = {}
    ): Promise<QueryResultMany> {
        if (options.transaction) {
            return this.runBulk(resource, items, options, async (repo, payload) => {
                const updated: any[] = []
                for (const item of payload) {
                    if (item.id === undefined || !Array.isArray(item.patches)) {
                        throw new Error('bulkPatch item missing id or patches')
                    }
                    const current = await repo.findOne({ where: { id: item.id } as any })
                    if (!current) {
                        throw new Error('Not found')
                    }
                    const base = this.toPlain(current)
                    const normalized = this.stripIdPrefix(item.patches, item.id)
                    const next = applyPatches(base, normalized)
                    const saved = await repo.save(next as any)
                    if (options.returning !== false) {
                        updated.push(saved)
                    }
                }
                if (options.returning === false) return []
                return options.select
                    ? repo.find({
                        where: { id: payload.map(p => p.id) } as any,
                        select: this.buildSelect(options.select, repo.metadata?.columns)
                    })
                    : updated
            })
        }

        const repo = this.dataSource.getRepository(resource as any)
        const data: any[] = []
        const partialFailures: Array<{ index: number; error: any }> = []

        for (let i = 0; i < items.length; i++) {
            const item = items[i]
            try {
                if (item.id === undefined || !Array.isArray(item.patches)) {
                    throw new Error('bulkPatch item missing id or patches')
                }
                const current = await repo.findOne({ where: { id: item.id } as any })
                if (!current) throw new Error('Not found')
                const base = this.toPlain(current)
                const normalized = this.stripIdPrefix(item.patches, item.id)
                const next = applyPatches(base, normalized)
                const saved = await repo.save(next as any)
                if (options.returning !== false) {
                    data.push(options.select
                        ? await repo.findOne({
                            where: { id: item.id } as any,
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
            transactionApplied: false
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

    private applyOrderBy(qb: SelectQueryBuilder<any>, orderBy: QueryParams['orderBy'], alias: string) {
        if (!orderBy) return
        const list = Array.isArray(orderBy) ? orderBy : [orderBy]
        list.forEach((rule, idx) => {
            const direction = rule.direction?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
            const column = `${alias}.${rule.field}`
            if (idx === 0) qb.orderBy(column, direction)
            else qb.addOrderBy(column, direction)
        })
    }

    private applyCursor(qb: SelectQueryBuilder<any>, cursor: QueryParams['cursor'], alias: string) {
        if (cursor === undefined) return
        qb.andWhere(`${alias}.id > :cursor`, { cursor })
    }

    private buildSelectFields(select: Record<string, boolean>, alias: string) {
        const fields = Object.entries(select).filter(([, enabled]) => enabled).map(([key]) => `${alias}.${key}`)
        return fields.length ? fields : undefined
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
        return this.options.aliasPrefix ? `${this.options.aliasPrefix}_${resource}` : resource
    }

    private normalizeWhereOrId(whereOrId: any) {
        if (whereOrId && typeof whereOrId === 'object' && !Array.isArray(whereOrId)) return whereOrId
        return { id: whereOrId }
    }

    private toError(err: any) {
        if (err?.code && err?.message) return err
        return { code: 'INTERNAL', message: err?.message || String(err), details: err }
    }

    private toPlain(obj: any) {
        // 简单且安全地去掉原型，确保 Immer 可 draft
        return obj ? JSON.parse(JSON.stringify(obj)) : obj
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

    private async runBulk(
        resource: string,
        payload: any[],
        options: WriteOptions,
        executor: (repo: any, payload: any[]) => Promise<any>
    ): Promise<QueryResultMany> {
        const runner = options.transaction ? this.dataSource.createQueryRunner() : undefined
        try {
            if (runner) await runner.startTransaction()
            const repo = (runner?.manager ?? this.dataSource).getRepository(resource as any)
            const data = await executor(repo, payload)
            if (runner) await runner.commitTransaction()
            return {
                data: Array.isArray(data) ? data : [],
                transactionApplied: Boolean(runner)
            }
        } catch (err) {
            if (runner) await runner.rollbackTransaction()
            throw err
        } finally {
            if (runner) await runner.release()
        }
    }
}
