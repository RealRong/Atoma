import { FindManyOptions, PageInfo } from '../../core/types'

export type ArrayFormat = 'repeat' | 'comma' | 'json'

export interface QuerySerializerConfig {
    arrayFormat?: ArrayFormat
    legacyMode?: boolean
}

export function normalizeFindManyResponse<T>(data: any): { data: T[]; pageInfo?: PageInfo } {
    if (Array.isArray(data)) return { data }
    if (data && Array.isArray(data.data)) return { data: data.data, pageInfo: data.pageInfo }
    if (data && Array.isArray(data.items)) return { data: data.items, pageInfo: data.pageInfo }
    return { data: [] }
}

export function buildQueryParams<T>(options?: FindManyOptions<T>, config: QuerySerializerConfig = {}): URLSearchParams {
    const { arrayFormat = 'repeat', legacyMode = false } = config
    const params = new URLSearchParams()
    if (!options) return params

    if (options.where) {
        Object.entries(options.where as any).forEach(([field, cond]) => {
            if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
                // operators
                if ('in' in cond && Array.isArray((cond as any).in)) {
                    serializeArray(params, field, (cond as any).in, arrayFormat)
                } else {
                    Object.entries(cond as any).forEach(([op, val]) => {
                        if (val === undefined) return
                        params.append(`${field}_${op}`, String(val))
                    })
                }
            } else if (cond !== undefined && cond !== null) {
                params.append(field, String(cond))
            }
        })
    }

    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.offset !== undefined) params.set('offset', String(options.offset))
    if (options.cursor) params.set('cursor', options.cursor)

    if (options.orderBy) {
        const orderByArray = Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy]
        if (legacyMode) {
            orderByArray.forEach(({ field, direction }) => {
                params.set('sortBy', String(field))
                params.set('sortOrder', direction)
            })
        } else {
            orderByArray.forEach(({ field, direction }) => {
                params.append('orderBy', `${String(field)}:${direction}`)
            })
        }
    }

    return params
}

function serializeArray(params: URLSearchParams, key: string, values: any[], format: ArrayFormat): void {
    switch (format) {
        case 'repeat':
            values.forEach(v => params.append(key, String(v)))
            break
        case 'comma':
            params.set(key, values.map(v => String(v)).join(','))
            break
        case 'json':
            params.set(key, JSON.stringify(values))
            break
    }
}
