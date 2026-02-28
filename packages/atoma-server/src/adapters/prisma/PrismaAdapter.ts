import type { Query, SortRule, WriteOptions } from 'atoma-types/protocol'
import type {
    IOrmAdapter,
    OrmAdapterOptions,
    QueryResult,
    QueryResultOne
} from '../ports'
import {
    compareOpForAfter,
    decodeCursorToken,
    encodeCursorToken,
    getCursorValuesFromRow,
    isSameSort,
    readNullCursorField,
    reverseOrderBy
} from '../shared/keyset'
import { createError, isAtomaError, throwError } from '../../error'
import { prismaBatchFindMany, prismaFindMany } from './query'
import { prismaCreate, prismaDelete, prismaUpdate, prismaUpsert } from './write'

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
        return prismaFindMany(this, resource, query)
    }

    async batchFindMany(requests: Array<{ resource: string; query: Query }>): Promise<QueryResult[]> {
        return prismaBatchFindMany(this, requests)
    }

    async create(resource: string, data: any, options: WriteOptions = {}): Promise<QueryResultOne> {
        return prismaCreate(this, resource, data, options)
    }

    async update(
        resource: string,
        item: { id: any; data: any; baseVersion?: number },
        options: WriteOptions = {}
    ): Promise<QueryResultOne> {
        return prismaUpdate(this, resource, item, options)
    }

    async delete(resource: string, whereOrId: any, options: WriteOptions = {}): Promise<QueryResultOne> {
        return prismaDelete(this, resource, whereOrId, options)
    }

    async upsert(
        resource: string,
        item: { id: any; data: any; expectedVersion?: number; conflict?: 'cas' | 'lww'; apply?: 'merge' | 'replace' },
        options: WriteOptions = {}
    ): Promise<QueryResultOne> {
        return prismaUpsert(this, resource, item, options)
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
        return { [this.idField]: whereOrId }
    }

    private toError(reason: any) {
        if (isAtomaError(reason)) return reason
        // Do not leak raw adapter/DB errors to clients.
        return createError('INTERNAL', 'Internal error', { kind: 'adapter' })
    }

    private async findOneByKey(
        client: PrismaClientLike,
        resource: string,
        field: string,
        value: any,
        select?: Record<string, boolean>
    ) {
        const delegate = this.requireDelegateFromClient(client, resource, 'findMany')
        const list = await delegate.findMany({
            where: { [field]: value },
            ...(select ? { select } : {}),
            take: 1
        })
        return Array.isArray(list) ? list[0] : undefined
    }

    private readAffectedCount(value: any): number {
        if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
        const count = Number((value as any)?.count)
        if (Number.isFinite(count)) return Math.max(0, Math.floor(count))
        return 0
    }

    private isUniqueViolation(error: unknown): boolean {
        return Boolean(error && typeof error === 'object' && (error as any).code === 'P2002')
    }

    private toUpdateData(row: any, idField: string) {
        if (!row || typeof row !== 'object') return row
        const { [idField]: _id, ...rest } = row
        return rest
    }

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
        let decoded: ReturnType<typeof decodeCursorToken>
        try {
            decoded = decodeCursorToken(token)
        } catch {
            throwError('INVALID_QUERY', 'Invalid cursor token', { kind: 'validation', path: before ? 'before' : 'after' })
        }

        const path = before ? 'before' : 'after'
        if (!isSameSort(decoded.sort, orderBy)) {
            throwError('INVALID_QUERY', 'Cursor token sort does not match query.sort', { kind: 'validation', path })
        }
        this.assertCursorValuesComparable(decoded.values, orderBy, path)

        const keysetWhere = this.buildPrismaKeysetWhere(queryOrderBy, decoded.values, path)

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

    private encodePageCursor(row: any, orderBy: SortRule[]) {
        const values = getCursorValuesFromRow(row, orderBy)
        this.assertCursorValuesComparable(values, orderBy, 'page.cursor')
        return encodeCursorToken(values, orderBy)
    }

    private assertCursorValuesComparable(values: unknown[], orderBy: SortRule[], path: string) {
        if (values.length < orderBy.length) {
            throwError('INVALID_QUERY', 'Invalid cursor token', { kind: 'validation', path })
        }
        const nullField = readNullCursorField(values, orderBy)
        if (nullField) {
            throwError('INVALID_QUERY', 'Cursor pagination does not support null sort values', {
                kind: 'validation',
                path,
                field: nullField
            })
        }
    }
}
