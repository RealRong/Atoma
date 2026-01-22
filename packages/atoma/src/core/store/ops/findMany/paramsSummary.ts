import type { FindManyOptions } from '../../../types'

export function summarizeFindManyParams<T>(opts?: FindManyOptions<T>) {
    if (!opts) return {}

    const where = opts.where
    const whereFields = (where && typeof where === 'object' && !Array.isArray(where))
        ? Object.keys(where as any)
        : undefined

    const orderBy = opts.orderBy
    const orderByFields = orderBy
        ? (Array.isArray(orderBy) ? orderBy : [orderBy]).map(r => String((r as any).field))
        : undefined

    return {
        whereFields,
        orderByFields,
        limit: typeof opts.limit === 'number' ? opts.limit : undefined,
        offset: typeof opts.offset === 'number' ? opts.offset : undefined,
        before: typeof (opts as any).before === 'string' ? (opts as any).before : undefined,
        after: typeof (opts as any).after === 'string' ? (opts as any).after : undefined,
        cursor: typeof (opts as any).cursor === 'string' ? (opts as any).cursor : undefined,
        includeTotal: typeof (opts as any).includeTotal === 'boolean' ? (opts as any).includeTotal : undefined,
        fields: Array.isArray((opts as any).fields) ? (opts as any).fields : undefined,
        skipStore: Boolean((opts as any).skipStore)
    }
}
