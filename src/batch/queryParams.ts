import type { FindManyOptions } from '../core/types'

export function normalizeAtomaServerQueryParams<T>(input: FindManyOptions<T> | undefined) {
    const params: any = (input && typeof input === 'object') ? { ...input } : {}

    // 仅保留 server QueryParams 支持的字段（where/orderBy/page/select）
    delete params.include
    delete params.cache
    delete params.skipStore
    delete params.traceId
    delete params.explain
    delete params.fetchPolicy

    // sparse fieldset alias: FindManyOptions.fields -> server QueryParams.select
    if (Array.isArray(params.fields) && params.fields.length) {
        const select: Record<string, boolean> = (params.select && typeof params.select === 'object' && !Array.isArray(params.select))
            ? { ...params.select }
            : {}
        params.fields.forEach((f: any) => {
            if (typeof f === 'string' && f) select[f] = true
        })
        params.select = Object.keys(select).length ? select : undefined
        delete params.fields
    }

    // 若调用方已显式提供 server 侧 QueryParams（含 page），直接透传
    if (params.page && typeof params.page === 'object' && (params.page.mode === 'offset' || params.page.mode === 'cursor')) {
        if (params.orderBy && !Array.isArray(params.orderBy)) {
            params.orderBy = [params.orderBy]
        }
        return params
    }

    // FindManyOptions.orderBy 支持 object | array；server 协议要求数组
    if (params.orderBy && !Array.isArray(params.orderBy)) {
        params.orderBy = [params.orderBy]
    }

    const limit = typeof params.limit === 'number' ? params.limit : 50
    const offset = typeof params.offset === 'number' ? params.offset : undefined
    const includeTotal = typeof params.includeTotal === 'boolean' ? params.includeTotal : undefined

    const before = typeof params.before === 'string' ? params.before : undefined
    const after = typeof params.after === 'string' ? params.after : undefined
    const cursor = typeof params.cursor === 'string' ? params.cursor : undefined

    if (before || after || cursor) {
        params.page = {
            mode: 'cursor',
            limit,
            before,
            after: after ?? cursor
        }
    } else {
        params.page = {
            mode: 'offset',
            limit,
            offset,
            ...(includeTotal !== undefined ? { includeTotal } : {})
        }
    }

    // 防止旧字段误导：server REST/Batch 协议不使用 cursor（走 page.after/before）
    delete params.cursor
    delete params.limit
    delete params.offset
    delete params.includeTotal
    delete params.before
    delete params.after

    return params
}
