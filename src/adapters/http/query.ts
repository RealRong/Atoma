import { FindManyOptions, PageInfo } from '../../core/types'

export function normalizeFindManyResponse<T>(data: any): { data: T[]; pageInfo?: PageInfo } {
    if (Array.isArray(data)) return { data }
    if (data && Array.isArray(data.data)) return { data: data.data, pageInfo: data.pageInfo }
    if (data && Array.isArray(data.items)) return { data: data.items, pageInfo: data.pageInfo }
    return { data: [] }
}

export function buildQueryParams<T>(options?: FindManyOptions<T>): URLSearchParams {
    const params = new URLSearchParams()
    if (!options) return params

    if (options.where) {
        Object.entries(options.where as any).forEach(([field, cond]) => {
            if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
                Object.entries(cond as any).forEach(([op, val]) => {
                    if (val !== undefined) params.append(`${field}_${op}`, String(val))
                })
            } else if (cond !== undefined) {
                params.append(field, String(cond))
            }
        })
    }

    if (options.orderBy) {
        params.append('orderBy', JSON.stringify(options.orderBy))
    }

    if (options) {
        if (options.limit !== undefined) params.append('limit', String(options.limit))
        if (options.offset !== undefined) params.append('offset', String(options.offset))
        if (options.cursor) params.append('cursor', options.cursor)
    }

    if (options.limit !== undefined) params.append('limit', String(options.limit))
    if (options.offset !== undefined) params.append('offset', String(options.offset))

    return params
}
