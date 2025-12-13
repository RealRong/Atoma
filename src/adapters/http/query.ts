import { FindManyOptions, PageInfo } from '../../core/types'

export interface QuerySerializerConfig {
}

export function normalizeFindManyResponse<T>(data: any): { data: T[]; pageInfo?: PageInfo } {
    if (Array.isArray(data)) return { data }
    if (data && Array.isArray(data.data)) return { data: data.data, pageInfo: data.pageInfo }
    if (data && Array.isArray(data.items)) return { data: data.items, pageInfo: data.pageInfo }
    return { data: [] }
}

export function buildQueryParams<T>(options?: FindManyOptions<T>, config: QuerySerializerConfig = {}): URLSearchParams {
    const params = new URLSearchParams()
    if (!options) return params

    // sparse fieldset：fields=a,b,c
    if (Array.isArray((options as any).fields) && (options as any).fields.length) {
        params.set('fields', (options as any).fields.join(','))
    }

    if (options.where) {
        Object.entries(options.where as any).forEach(([field, cond]) => {
            if (cond === undefined || cond === null) return

            // Atoma server REST 协议（bracket 风格）：
            // - where[field]=x
            // - where[field][op]=x
            // - where[field][in][]=1&where[field][in][]=2
            if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
                if ('in' in cond && Array.isArray((cond as any).in)) {
                    ;((cond as any).in as any[]).forEach(v => {
                        params.append(`where[${field}][in][]`, String(v))
                    })
                    return
                }

                Object.entries(cond as any).forEach(([op, val]) => {
                    if (val === undefined || val === null) return
                    params.append(`where[${field}][${op}]`, String(val))
                })
                return
            }

            params.append(`where[${field}]`, String(cond))
        })
    }

    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.offset !== undefined) params.set('offset', String(options.offset))

    const anyOptions = options as any
    const includeTotal = anyOptions.includeTotal
    if (includeTotal !== undefined) params.set('includeTotal', String(Boolean(includeTotal)))

    const before = typeof anyOptions.before === 'string' ? anyOptions.before : undefined
    const after = typeof anyOptions.after === 'string' ? anyOptions.after : undefined

    if (before) {
        params.set('before', before)
    } else if (after) {
        params.set('after', after)
    } else if (options.cursor) {
        // FindManyOptions.cursor 作为“续页 token”，在 Atoma server REST 层对应 after
        params.set('after', options.cursor)
    }

    if (options.orderBy) {
        const orderByArray = Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy]
        orderByArray.forEach(({ field, direction }) => {
            params.append('orderBy', `${String(field)}:${direction}`)
        })
    }

    return params
}
