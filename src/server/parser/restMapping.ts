import type { BatchRequest, QueryParams } from '../types'

type RestMappingParams = {
    method: string
    pathParts: string[]
    searchParams: URLSearchParams
    body: any
}

export function restMapping({ method, pathParts, searchParams, body }: RestMappingParams): BatchRequest | null {
    const resource = pathParts[0]
    const id = pathParts[1]
    if (!resource) return null

    const params = parseQueryParams(searchParams)
    const numericId = toNumberIfFinite(id)

    if (method === 'GET') {
        if (id !== undefined) {
            params.where = { ...(params.where || {}), id: numericId }
            params.limit = 1
        }
        return {
            action: 'query',
            queries: [{ resource, params }]
        }
    }

    if (method === 'POST' && id === undefined) {
        return { action: 'create', resource, payload: body }
    }

    if ((method === 'PUT' || method === 'PATCH' || method === 'POST') && id !== undefined) {
        const payload = typeof body === 'object' && body ? { ...body, id: numericId } : { id: numericId }
        const action = Array.isArray((payload as any).patches) ? 'patch' : 'update'
        return {
            action,
            resource,
            payload,
            where: { id: numericId }
        }
    }

    if (method === 'DELETE' && id !== undefined) {
        return { action: 'delete', resource, where: { id: numericId } }
    }

    return null
}

function parseQueryParams(searchParams: URLSearchParams): QueryParams {
    const params: QueryParams = {}
    const where: Record<string, any> = {}
    const orderRules: Array<{ field: string; direction: 'asc' | 'desc' }> = []

    searchParams.forEach((value, key) => {
        if (key === 'limit') {
            params.limit = toNumberIfFinite(value) as number | undefined
            return
        }
        if (key === 'offset') {
            params.offset = toNumberIfFinite(value) as number | undefined
            return
        }
        if (key === 'cursor') {
            params.cursor = value
            return
        }
        if (key === 'orderBy') {
            const [field, dir] = value.split(':')
            if (field) {
                orderRules.push({ field, direction: dir?.toLowerCase() === 'asc' ? 'asc' : 'desc' })
            }
            return
        }
        if (key.startsWith('where.')) {
            const field = key.slice(6)
            if (field) where[field] = toPrimitive(value)
            return
        }
        where[key] = toPrimitive(value)
    })

    if (orderRules.length) params.orderBy = orderRules.length === 1 ? orderRules[0] : orderRules
    if (Object.keys(where).length) params.where = where
    return params
}

function toPrimitive(value: string) {
    if (value === 'true') return true
    if (value === 'false') return false
    const num = Number(value)
    if (Number.isFinite(num) && value.trim() !== '') return num
    return value
}

function toNumberIfFinite(v: any) {
    const n = Number(v)
    return Number.isFinite(n) ? n : v
}
