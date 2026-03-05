import type { Query } from 'atoma-types/protocol'
import type { QueryResult } from '../ports'
import { ensureStableOrderBy } from '../shared/keyset'
import { compileFilterToPrismaWhere } from '../../query/compile'
import { throwError } from '../../error'

function normalizeOptionalLimit(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return Math.max(0, Math.floor(value))
}

function normalizeOffset(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    return Math.max(0, Math.floor(value))
}

export async function prismaFindMany(adapter: any, resource: string, query: Query = {}): Promise<QueryResult> {
    const delegate = adapter.getDelegate(resource)
    if (!delegate?.findMany) {
        throwError('RESOURCE_NOT_ALLOWED', `Resource not allowed: ${resource}`, { kind: 'auth', resource })
    }

    const orderBy = ensureStableOrderBy(query.sort, {
        idField: adapter.idField,
        defaultSort: adapter.defaultSort
    })

    const baseWhere = compileFilterToPrismaWhere(query.filter)
    const page = query.page
    const pageMode = page?.mode ?? undefined
    const beforeToken = (pageMode === 'cursor' && typeof (page as any).before === 'string') ? (page as any).before as string : undefined
    const afterToken = (pageMode === 'cursor' && typeof (page as any).after === 'string') ? (page as any).after as string : undefined

    const cursor = (pageMode === 'cursor' && (beforeToken || afterToken))
        ? { token: beforeToken ?? afterToken!, before: Boolean(beforeToken) }
        : undefined

    const { prismaOrderBy, reverseResult, keysetWhere } = adapter.buildKeysetWhere(cursor, orderBy)
    const where = keysetWhere ? adapter.andWhere(baseWhere, keysetWhere) : baseWhere

    if (!page) {
        const data = await delegate.findMany({ where, orderBy: prismaOrderBy })
        return { data }
    }

    if (pageMode === 'offset') {
        const skip = normalizeOffset((page as any).offset) ?? 0
        const take = normalizeOptionalLimit((page as any).limit)
        const includeTotal = (page as any).includeTotal === true

        if (includeTotal && delegate.count && typeof take === 'number') {
            const [data, total] = await Promise.all([
                delegate.findMany({ where, orderBy: prismaOrderBy, skip, take }),
                delegate.count({ where })
            ])
            return {
                data,
                pageInfo: {
                    total,
                    hasNext: skip + take < total
                }
            }
        }

        if (typeof take === 'number') {
            const data = await delegate.findMany({ where, orderBy: prismaOrderBy, skip, take: take + 1 })
            const hasNext = data.length > take
            const sliced = data.slice(0, take)
            return {
                data: sliced,
                pageInfo: { hasNext, ...(includeTotal && delegate.count ? { total: await delegate.count({ where }) } : {}) }
            }
        }

        const data = await delegate.findMany({ where, orderBy: prismaOrderBy, skip })
        return {
            data,
            pageInfo: { hasNext: false, ...(includeTotal && delegate.count ? { total: await delegate.count({ where }) } : {}) }
        }
    }

    const take = normalizeOptionalLimit((page as any).limit) ?? 50
    const data = await delegate.findMany({
        where,
        orderBy: prismaOrderBy,
        take: take + 1
    })
    const hasNext = data.length > take
    const sliced = data.slice(0, take)
    const finalRows = reverseResult ? sliced.reverse() : sliced

    const cursorRow = cursor?.before ? finalRows[0] : finalRows[finalRows.length - 1]
    const nextCursor = cursorRow
        ? adapter.encodePageCursor(cursorRow, orderBy)
        : undefined

    return {
        data: finalRows,
        pageInfo: {
            hasNext,
            cursor: nextCursor
        }
    }
}

export async function prismaBatchFindMany(adapter: any, requests: Array<{ resource: string; query: Query }>): Promise<QueryResult[]> {
    const operations = requests.map(r => adapter.findMany(r.resource, r.query))
    if (adapter.client.$transaction) {
        return adapter.client.$transaction(operations)
    }
    return Promise.all(operations)
}
