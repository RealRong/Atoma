import type { FindManyOptions } from '../../types'
import type { OrderByRule, QueryParams } from '#protocol'

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOrderBy(orderBy: unknown): OrderByRule[] | undefined {
    if (!orderBy) return undefined
    const arr = Array.isArray(orderBy) ? orderBy : [orderBy]
    const rules: OrderByRule[] = []
    for (const r of arr) {
        if (!isPlainObject(r)) continue
        const field = (r as any).field
        const direction = (r as any).direction
        if (typeof field !== 'string') continue
        if (direction !== 'asc' && direction !== 'desc') continue
        rules.push({ field, direction })
    }
    return rules.length ? rules : undefined
}

/**
 * 将 `FindManyOptions<T>` 严格映射为协议 `QueryParams`（仅保留服务端支持字段）。
 * - where: 只接受 plain object（函数 where 不会下发）
 * - orderBy: 规范化为数组规则
 * - fields/limit/offset/includeTotal/after/before/cursor: 直接映射并做基础校验
 */
export function normalizeAtomaServerQueryParams<T>(input: FindManyOptions<T> | undefined): QueryParams {
    const i = (input && typeof input === 'object') ? input : undefined

    const out: QueryParams = {}

    const whereInput: unknown = i?.where
    if (isPlainObject(whereInput)) {
        out.where = { ...whereInput }
    }

    const orderBy = normalizeOrderBy(i?.orderBy)
    if (orderBy) out.orderBy = orderBy

    if (Array.isArray(i?.fields) && i!.fields!.length) {
        out.fields = i!.fields!.filter(f => typeof f === 'string' && f)
    }

    if (typeof i?.limit === 'number' && Number.isFinite(i.limit)) out.limit = i.limit
    if (typeof i?.offset === 'number' && Number.isFinite(i.offset)) out.offset = i.offset
    if (typeof i?.includeTotal === 'boolean') out.includeTotal = i.includeTotal

    const after = (typeof i?.after === 'string' && i.after) ? i.after : undefined
    const cursor = (typeof (i as any)?.cursor === 'string' && (i as any).cursor) ? (i as any).cursor as string : undefined
    const afterOrCursor = after ?? cursor
    if (afterOrCursor) out.after = afterOrCursor
    if (typeof i?.before === 'string' && i.before) out.before = i.before

    return out
}

