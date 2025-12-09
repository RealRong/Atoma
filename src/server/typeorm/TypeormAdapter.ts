import type { DataSource, SelectQueryBuilder } from 'typeorm'
import type { IOrmAdapter, QueryParams, QueryResult } from '../types'

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
}
